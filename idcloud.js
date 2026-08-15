// idcloud.js — Cliente do BANCO DO iZCloud (NOSSO MySQL, modelo iDCloud)
// Este e o banco da NOSSA nuvem (nao o da ControlID). O REP sincroniza aqui
// (se configuravel) ou nosso servidor popula aqui via FCGI IP-direto.
// Credenciais vindas do NOSSO servidor (env IDCLOUD_*).
import mysql from 'mysql2/promise';

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
    const [rows] = await this.pool.query('SELECT id_Equipamento, Nome, utc_Equipamento, statusPapel, qtdePessoas, qtdeDigitais FROM equipamentos');
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
  async salvarAfd(idEquipamento, linhas) {
    for (const l of linhas) {
      const t = l[9];
      if (t !== '3') continue; // so batidas
      const nsr = parseInt(l.substring(0, 9), 10);
      const is671 = l.length > 14 && l[14] === '-';
      let documento = '';
      let data = null;
      try {
        if (is671) {
          documento = l.substring(34, 45);
          const dh = l.substring(10, 29);
          data = new Date(dh);
        } else {
          const d = l.substring(10, 12), m = l.substring(12, 14), y = l.substring(14, 18);
          const hh = l.substring(18, 20), mm = l.substring(20, 22);
          documento = l.substring(22, 34);
          data = new Date(y, parseInt(m, 10) - 1, d, hh, mm);
        }
      } catch {}
      await this.pool.query(
        'INSERT INTO afd (id_Equipamento, PIS, NSR, Data, Tipo, Dado, CRC) VALUES (?, ?, ?, ?, 3, ?, NULL) ' +
        'ON DUPLICATE KEY UPDATE Dado = VALUES(Dado)',
        [idEquipamento, documento || null, nsr, data, l.trim()]
      );
    }
  }

  // Grava pessoa no REP. 1510 -> PIS; 671 -> CPF. Ambas colunas existem.
  async gravarPessoa(p) {
    const is671 = p.portaria === '671';
    const sql = `INSERT INTO pessoas
      (PIS, CPF, Nome, Codigo, Senha, Matricula, Admin, Rfid, Barras, Excluido, ExcluidoDefinitivo, DataAtualizacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NOW())`;
    const params = [
      is671 ? null : (p.pis || null),
      is671 ? (p.cpf || null) : null,
      p.nome,
      p.codigo || null,
      p.senha || null,
      p.matricula || null,
      p.admin ? 1 : 0,
      p.rfid || null,
      p.barras || null,
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
}
