// idcloud.js — Cliente do BANCO DO iZCloud (NOSSO MySQL, modelo iDCloud)
// Este e o banco da NOSSA nuvem (nao o da ControlID). O REP sincroniza aqui
// (se configuravel) ou nosso servidor popula aqui via FCGI IP-direto.
// Credenciais vindas do NOSSO servidor (env IDCLOUD_*).
import mysql from 'mysql2/promise';
import { extrairDocumento } from './afd.js';

export class IdCloudClient {
  // Em multi-tenant, recebe o pool ja apontando para o schema do cliente.
  constructor(pool) {
    this.pool = pool;
  }

  static fromEnv() {
    return new IdCloudClient(
      mysql.createPool({
        host: process.env.IDCLOUD_HOST,
        port: Number(process.env.IDCLOUD_PORT || 3306),
        user: process.env.IDCLOUD_USER,
        password: process.env.IDCLOUD_PASS,
        database: process.env.IDCLOUD_DB,
        ssl: { rejectUnauthorized: false },
        waitForConnections: true,
        connectionLimit: 5,
      })
    );
  }

  async close() { await this.pool.end(); }

  // Equipamentos (somente leitura, conforme doc iDCloud)
  async listarEquipamentos() {
    // `Serial` pode nao existir em tenant criado antes da migracao do contrato
    // iDCloud; por isso o COALESCE evita 500 na lista de REPs.
    const [rows] = await this.pool.query(
      "SELECT id_Equipamento, COALESCE(Serial, CAST(id_Equipamento AS CHAR)) AS Serial, " +
      'Nome, utc_Equipamento, statusPapel, qtdePessoas, qtdeDigitais, IpAddress, Porta, REPType, ModoConexao ' +
      'FROM equipamentos ORDER BY id_Equipamento'
    );
    return rows;
  }

  // Leitura do AFD (somente leitura). `Dado` = linha crua ja no layout do REP.
  // Filtra por equipamento e periodo (Data).
  async lerAfd({ idEquipamento, dataInicio, dataFim } = {}) {
    let sql = 'SELECT id_Equipamento, PIS, NSR, Data, Tipo, Dado, CRC FROM afd WHERE 1=1';
    const params = [];
    if (idEquipamento) { sql += ' AND id_Equipamento = ?'; params.push(idEquipamento); }
    if (dataInicio) { sql += ' AND Data >= ?'; params.push(dataInicio); }
    if (dataFim) { sql += ' AND Data <= ?'; params.push(dataFim); }
    sql += ' ORDER BY NSR ASC';
    const [rows] = await this.pool.query(sql, params);
    return rows; // cada row.Dado e a linha AFD crua
  }

  // Persiste AFD baixado (de FCGI ou do proprio REP) no banco da nuvem.
  // `linhas` = array de strings (linhas cruas '3' ou header/trailer).
  //
  // `desdeNsr` evita reprocessar o arquivo inteiro a cada coleta: quando o
  // canal passa a ler o AFD completo (dezenas de milhares de linhas), gravar
  // linha a linha estourava o tempo da conexao. O lote de 500 resolve os dois:
  // menos round-trips e menos memoria.
  async salvarAfd(idEquipamento, linhas, { desdeNsr = 0 } = {}) {
    let valores = [];
    let params = [];
    let gravadas = 0;
    const enviar = async () => {
      if (!valores.length) return;
      await this.pool.query(
        'INSERT INTO afd (id_Equipamento, PIS, NSR, Data, Tipo, Dado, CRC) VALUES ' +
        valores.join(', ') + ' ON DUPLICATE KEY UPDATE Dado = VALUES(Dado)',
        params
      );
      valores = [];
      params = [];
    };

    for (const l of linhas) {
      const t = l[9];
      if (t !== '3') continue; // so batidas
      const nsr = parseInt(l.substring(0, 9), 10);
      if (!Number.isFinite(nsr) || nsr <= desdeNsr) continue;
      const is671 = l.length > 14 && l[14] === '-';
      const documento = extrairDocumento(l);
      let data = null;
      try {
        if (is671) {
          data = new Date(l.substring(10, 29));
        } else {
          const d = l.substring(10, 12), m = l.substring(12, 14), y = l.substring(14, 18);
          const hh = l.substring(18, 20), mm = l.substring(20, 22);
          data = new Date(y, parseInt(m, 10) - 1, d, hh, mm);
        }
      } catch {}
      valores.push('(?, ?, ?, ?, 3, ?, NULL)');
      params.push(idEquipamento, documento || null, nsr, data, l.trim());
      gravadas++;
      if (valores.length >= 500) await enviar();
    }
    await enviar();
    return gravadas;
  }

  // Grava pessoa no REP. 1510 -> PIS; 671 -> CPF. Ambas colunas existem.
  //
  // Upsert por PIS/CPF: antes cada "Salvar" criava uma linha nova. O operador
  // que salvasse na nuvem e depois tentasse enviar ao REP duplicava o cadastro.
  async gravarPessoa(p) {
    const is671 = p.portaria === '671';
    const docs = is671 ? p.cpf : p.pis;
    const campos = [
      p.nome ?? null,
      p.codigo || null,
      p.senha || null,
      p.matricula || null,
      p.admin ? 1 : 0,
      p.rfid || null,
      p.barras || null,
    ];
    if (docs) {
      const col = is671 ? 'CPF' : 'PIS';
      const [ex] = await this.pool.query(
        `SELECT id_pessoa FROM pessoas WHERE ${col} = ? LIMIT 1`, [docs]
      );
      if (ex.length) {
        await this.pool.query(
          `UPDATE pessoas SET Nome=?, Codigo=?, Senha=COALESCE(?, Senha), Matricula=?, Admin=?,
                  Rfid=COALESCE(?, Rfid), Barras=COALESCE(?, Barras), DataAtualizacao=NOW()
            WHERE id_pessoa=?`,
          [...campos, ex[0].id_pessoa]
        );
        return ex[0].id_pessoa;
      }
    }
    const sql = `INSERT INTO pessoas
      (PIS, CPF, Nome, Codigo, Senha, Matricula, Admin, Rfid, Barras, Excluido, ExcluidoDefinitivo, DataAtualizacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NOW())`;
    const params = [
      is671 ? null : (p.pis || null),
      is671 ? (p.cpf || null) : null,
      ...campos,
    ];
    const [res] = await this.pool.query(sql, params);
    return res.insertId;
  }

  // Vincula pessoa ao equipamento (tabela equip_pessoa)
  async vincularEquipamento(idPessoa, idEquipamento) {
    await this.pool.query(
      'INSERT IGNORE INTO equip_pessoa (id_Pessoa, id_Equipamento) VALUES (?, ?)',
      [idPessoa, idEquipamento]
    );
  }

  // Inativa (exclusao definitiva) mantendo DataAtualizacao
  async inativarPessoa(pisOuCpf, portaria) {
    const col = portaria === '671' ? 'CPF' : 'PIS';
    await this.pool.query(
      `UPDATE pessoas SET ExcluidoDefinitivo = 1, DataAtualizacao = NOW() WHERE ${col} = ?`,
      [pisOuCpf]
    );
  }

  // Lista funcionarios (pessoas) do tenant
  async listarPessoas() {
    const [rows] = await this.pool.query(
      'SELECT id_pessoa, PIS, CPF, Nome, Codigo, Matricula, Admin FROM pessoas ORDER BY Nome'
    );
    return rows;
  }

  // Todos os vinculos pessoa<->equipamento (muitos-para-muitos via equip_pessoa)
  async listarTodosVinculos() {
    const [rows] = await this.pool.query('SELECT id_Pessoa, id_Equipamento FROM equip_pessoa');
    return rows;
  }

  // Vinculos de um equipamento especifico
  async listarVinculos(idEquipamento) {
    const [rows] = await this.pool.query(
      'SELECT id_Pessoa FROM equip_pessoa WHERE id_Equipamento = ?', [idEquipamento]
    );
    return rows.map(r => r.id_Pessoa);
  }

  // Define o SUBSET de funcionarios de um REP (substitui o conjunto atual)
  async definirVinculos(idEquipamento, ids) {
    await this.pool.query('DELETE FROM equip_pessoa WHERE id_Equipamento = ?', [idEquipamento]);
    for (const id of (ids || [])) {
      if (id) await this.pool.query(
        'INSERT IGNORE INTO equip_pessoa (id_Pessoa, id_Equipamento) VALUES (?, ?)', [id, idEquipamento]
      );
    }
  }

  // Importa/atualiza um funcionario vindo da memoria do REP (por PIS/CPF).
  // Traz o cadastro completo do aparelho (codigo, matricula, rfid, barras,
  // senha, admin), nao so o nome. A senha vazia no REP NAO apaga a senha que
  // ja existe na nuvem (COALESCE).
  async importarPessoa(p) {
    const is671 = p.portaria === '671' || (!p.pis && p.cpf);
    const col = is671 ? 'CPF' : 'PIS';
    const val = is671 ? p.cpf : p.pis;
    if (!val) throw new Error('Funcionario sem PIS/CPF');
    const [ex] = await this.pool.query(
      `SELECT id_pessoa, Senha FROM pessoas WHERE ${col} = ? LIMIT 1`, [val]
    );
    if (ex.length) {
      await this.pool.query(
        `UPDATE pessoas SET Nome=?, Codigo=?, Senha=COALESCE(?, Senha), Matricula=?,
                Admin=?, Rfid=?, Barras=?, Excluido=0, ExcluidoDefinitivo=0, DataAtualizacao=NOW()
          WHERE id_pessoa=?`,
        [p.nome || null, p.codigo ?? null, p.senha || null, p.matricula ?? null,
          p.admin ? 1 : 0, p.rfid || null, p.barras || null, ex[0].id_pessoa]
      );
      return ex[0].id_pessoa;
    }
    const [r] = await this.pool.query(
      `INSERT INTO pessoas
        (PIS, CPF, Nome, Codigo, Senha, Matricula, Admin, Rfid, Barras,
         Excluido, ExcluidoDefinitivo, DataAtualizacao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NOW())`,
      [is671 ? null : (p.pis || null), is671 ? (p.cpf || null) : null, p.nome || null,
        p.codigo ?? null, p.senha || '1234', p.matricula ?? null, p.admin ? 1 : 0,
        p.rfid || null, p.barras || null]
    );
    return r.insertId;
  }

  // Importa a empresa/empregador que o REP tem na memoria (load_company).
  // Grava em `empregadores` (contrato iDCloud) e aponta o equipamento para ela.
  // Se ja existir uma empresa com o mesmo CNPJ/CPF, atualiza em vez de duplicar.
  async importarEmpresa({ idEquipamento, empresa }) {
    if (!empresa) return null;
    const nome = String(empresa.name || empresa.nome || '').slice(0, 50) || null;
    const local = String(empresa.address || empresa.endereco || '').slice(0, 100) || null;
    const doc = String(empresa.cpf_cnpj || empresa.cnpj || empresa.cpf || '').replace(/\D/g, '') || null;
    const cei = String(empresa.cei || '').replace(/\D/g, '') || null;
    const tipo = Number(empresa.tipo_doc || 0);
    const tipoDocumento = tipo === 2 ? 'CPF' : 'CNPJ';
    const cpf = tipo === 2 ? doc : null;

    let id = null;
    if (doc) {
      const [ex] = await this.pool.query(
        'SELECT id_Empregador FROM empregadores WHERE CNPJ_CPF = ? LIMIT 1', [doc]
      );
      if (ex.length) {
        id = ex[0].id_Empregador;
        await this.pool.query(
          'UPDATE empregadores SET RazaoSocial=?, Local=?, CEI=?, CPF=? WHERE id_Empregador=?',
          [nome, local, cei, cpf, id]
        );
      }
    }
    if (!id) {
      const [r] = await this.pool.query(
        'INSERT INTO empregadores (RazaoSocial, Local, CNPJ_CPF, CEI, CPF) VALUES (?, ?, ?, ?, ?)',
        [nome, local, doc, cei, cpf]
      );
      id = r.insertId;
    }
    await this.pool.query(
      'UPDATE equipamentos SET id_Empregador = ? WHERE id_Equipamento = ?', [id, idEquipamento]
    );
    return {
      id_Empregador: id, RazaoSocial: nome, Local: local,
      CNPJ_CPF: doc, CEI: cei, tipo_documento: tipoDocumento,
    };
  }

  // Grava/atualiza um template biometrico (digital ou face) de uma pessoa.
  // `Template` e' o nome que o contrato iDCloud usa; `dados` e' o nosso. Manter
  // os dois iguais e' o que permite o REP/outro sistema ler a biometria.
  async gravarTemplate(id_pessoa, tipo, indice, dados) {
    if (!dados) return;
    await this.pool.query(
      `INSERT INTO templates (id_pessoa, tipo, indice, dados, Template, DataAtualizacao)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE dados = VALUES(dados), Template = VALUES(Template), DataAtualizacao = NOW()`,
      [id_pessoa, tipo, indice, dados, dados]
    );
  }

  async listarTemplates(id_pessoa) {
    const [rows] = await this.pool.query('SELECT tipo, indice, dados FROM templates WHERE id_pessoa = ?', [id_pessoa]);
    return rows;
  }

  // Contagem de biometria por pessoa (para exibir na UI).
  async contarBio() {
    const [rows] = await this.pool.query('SELECT id_pessoa, tipo, COUNT(*) c FROM templates GROUP BY id_pessoa, tipo');
    const m = {};
    rows.forEach(r => {
      m[r.id_pessoa] = m[r.id_pessoa] || { digital: 0, face: 0 };
      if (r.tipo === 'face') m[r.id_pessoa].face = r.c; else m[r.id_pessoa].digital = r.c;
    });
    return m;
  }

  // ===================================================================
  // METRICAS DO PAINEL
  // Tudo em uma transacao logica so, sobre as tabelas que ja existem.
  // Sem dado de AFD no banco (nunca sincronizou) os cards mostram 0 em vez de
  // erro — a UI decide o que fazer com isso.
  // ===================================================================

  // 'YYYY-MM-DD HH:00:00' para uma data local. O MySQL guarda DATETIME sem fuso,
  // entao o corte do dia tem de ser montado aqui, no mesmo fuso da maquina.
  _dia(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async painel(dias = 30) {
    const n = Math.min(Math.max(Number(dias) || 30, 7), 180);
    const hoje = new Date();
    const ini = new Date(hoje); ini.setDate(ini.getDate() - (n - 1));
    const dIni = this._dia(ini);
    const dHoje = this._dia(hoje);
    // primeiro dia do mes corrente
    const dMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;

    const [reps] = await this.pool.query(
      `SELECT e.id_Equipamento, e.Nome, e.IpAddress, e.Porta, e.REPType, e.ModoConexao,
              e.qtdePessoas, e.qtdeDigitais, s.last_sync, s.last_nsr, s.ativo AS sync_ativo
         FROM equipamentos e
         LEFT JOIN sync_status s ON s.id_Equipamento = e.id_Equipamento
        ORDER BY e.id_Equipamento`
    );

    const [totais] = await this.pool.query(
      `SELECT
         (SELECT COUNT(*) FROM pessoas) AS pessoas,
         (SELECT COUNT(*) FROM equipamentos) AS reps,
         (SELECT COUNT(*) FROM templates WHERE tipo = 'digital') AS digitais,
         (SELECT COUNT(*) FROM templates WHERE tipo = 'face') AS faces,
         (SELECT COUNT(*) FROM afd) AS afd_total`
    );

    const [hojeRow] = await this.pool.query(
      'SELECT COUNT(*) AS c FROM afd WHERE Data >= ? AND Data < DATE_ADD(?, INTERVAL 1 DAY)',
      [dHoje + ' 00:00:00', dHoje]
    );
    const [mesRow] = await this.pool.query(
      'SELECT COUNT(*) AS c FROM afd WHERE Data >= ?', [dMes + ' 00:00:00']
    );
    const [iniRow] = await this.pool.query(
      'SELECT COUNT(*) AS c FROM afd WHERE Data >= ? AND Data < DATE_ADD(?, INTERVAL 1 DAY)',
      [dIni + ' 00:00:00', dHoje]
    );

    // serie diaria: preenche os dias sem marcação com 0 (o grafico nao pode
    // "pular" um dia e fazer o cliente achar que nao houve coleta)
    const [serie] = await this.pool.query(
      `SELECT DATE(Data) AS dia, COUNT(*) AS c, COUNT(DISTINCT PIS) AS pessoas
         FROM afd
        WHERE Data >= ? AND Data < DATE_ADD(?, INTERVAL 1 DAY)
        GROUP BY DATE(Data) ORDER BY dia`,
      [dIni + ' 00:00:00', dHoje]
    );
    const porDia = {};
    for (const r of serie) {
      const d = r.dia instanceof Date ? this._dia(r.dia) : String(r.dia).slice(0, 10);
      porDia[d] = { total: Number(r.c) || 0, pessoas: Number(r.pessoas) || 0 };
    }
    const serieDias = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(ini); d.setDate(d.getDate() + i);
      const chave = this._dia(d);
      serieDias.push({ dia: chave, ...(porDia[chave] || { total: 0, pessoas: 0 }) });
    }

    // marcações por REP no periodo (grafico de barras comparativo)
    const [porRep] = await this.pool.query(
      `SELECT id_Equipamento, COUNT(*) AS total
         FROM afd WHERE Data >= ? AND Data < DATE_ADD(?, INTERVAL 1 DAY)
        GROUP BY id_Equipamento`,
      [dIni + ' 00:00:00', dHoje]
    );
    const porRepMap = {};
    for (const r of porRep) porRepMap[r.id_Equipamento] = Number(r.total) || 0;

    // ultimas batidas (amostra para a tabela)
    const [ultimas] = await this.pool.query(
      `SELECT a.id_Equipamento, a.PIS, a.NSR, a.Data, e.Nome AS rep_nome
         FROM afd a LEFT JOIN equipamentos e ON e.id_Equipamento = a.id_Equipamento
        ORDER BY a.Data DESC, a.NSR DESC LIMIT 10`
    );

    // empresa mais ativa no periodo — util como "destaque" do painel
    const [topPessoas] = await this.pool.query(
      `SELECT p.id_pessoa, p.Nome, p.PIS, p.CPF, COUNT(*) AS c
         FROM afd a JOIN pessoas p ON (p.PIS = a.PIS OR p.CPF = a.PIS)
        WHERE a.Data >= ? AND a.Data < DATE_ADD(?, INTERVAL 1 DAY)
        GROUP BY p.id_pessoa, p.Nome, p.PIS, p.CPF
        ORDER BY c DESC LIMIT 5`,
      [dIni + ' 00:00:00', dHoje]
    );

    const ultimaSync = reps.map((r) => r.last_sync).filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;

    return {
      periodo_dias: n,
      cards: {
        pessoas: Number(totais[0].pessoas) || 0,
        reps: Number(totais[0].reps) || 0,
        digitais: Number(totais[0].digitais) || 0,
        faces: Number(totais[0].faces) || 0,
        marcacoes_hoje: Number(hojeRow[0].c) || 0,
        marcacoes_mes: Number(mesRow[0].c) || 0,
        marcacoes_periodo: Number(iniRow[0].c) || 0,
        afd_total: Number(totais[0].afd_total) || 0,
        ultima_sync: ultimaSync,
      },
      serie: serieDias,
      por_rep: reps.map((r) => ({
        id_Equipamento: r.id_Equipamento,
        nome: r.Nome,
        tipo: r.REPType,
        modo: r.ModoConexao || 'nuvem_puxa',
        ip: r.IpAddress,
        porta: r.Porta,
        qtdePessoas: Number(r.qtdePessoas) || 0,
        qtdeDigitais: Number(r.qtdeDigitais) || 0,
        last_sync: r.last_sync,
        last_nsr: r.last_nsr === null ? null : Number(r.last_nsr) || 0,
        sync_ativo: r.sync_ativo === null ? null : !!r.sync_ativo,
        marcacoes_periodo: porRepMap[r.id_Equipamento] || 0,
      })),
      ultimas_marcacoes: ultimas.map((r) => ({
        id_Equipamento: r.id_Equipamento,
        rep_nome: r.rep_nome,
        pis: r.PIS,
        nsr: r.NSR,
        data: r.Data,
      })),
      top_pessoas: topPessoas.map((r) => ({
        id_pessoa: r.id_pessoa,
        nome: r.Nome,
        documento: r.CPF || r.PIS,
        marcacoes: Number(r.c) || 0,
      })),
    };
  }
}
