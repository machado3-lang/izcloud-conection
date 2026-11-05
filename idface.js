// idface.js — coletor do iDFace (push oficial) para o iZCloud.
//
// O iDFace NAO e' REP-P: ele so entrega marcacoes (`access_logs`) e o AFD do
// proprio coletor (595/671). Quem trata jornada e emite AFD/AFDT/ACJEF/AEJ
// fiscal e' o REP-P/PTRP do cliente (MultiPonto, etc.). O iZCloud guarda:
//   - o dispositivo e o token do push;
//   - a fila de comandos e os resultados (auditoria);
//   - as marcacoes cruas + o AFD bruto;
//   - o vinculo versionado device_user_id <-> pessoa.
//
// Formato oficial do push (medido no iDFace 6.26.4 em 05/11/2026):
//   GET  /api/idface/<token>/push?deviceId=...&uuid=...
//     -> {verb, endpoint, body, contentType} ou {transactions:[]}
//   POST /api/idface/<token>/result?deviceId=...&uuid=...&endpoint=...
//     -> {response: ...} ou {error: ...}
import crypto from 'crypto';
import { extrairDocumento } from './afd.js';

const TIPOS_BATIDA = new Set(['3', '7']);

export function novoToken() {
  return crypto.randomBytes(24).toString('hex'); // 48 chars
}

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

function docNormalizado(v) {
  const d = soDigitos(v);
  if (!d) return '';
  // 671 do iDFace manda 12 digitos (zero a esquerda). Guardamos 11.
  return d.length === 12 && d.startsWith('0') ? d.slice(1) : d;
}

function fusoDeDh(dh) {
  const m = String(dh || '').match(/([+-]\d{4})$/);
  return m ? m[1] : null;
}

function dataDeAfd1510(linha) {
  const d = linha.substring(10, 12);
  const m = linha.substring(12, 14);
  const y = linha.substring(14, 18);
  const hh = linha.substring(18, 20);
  const mm = linha.substring(20, 22);
  if (!/^\d{2}$/.test(d) || !/^\d{2}$/.test(m) || !/^\d{4}$/.test(y)) return null;
  const data = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), 0);
  return Number.isNaN(data.getTime()) ? null : data;
}

function dataDeDh(dh) {
  const data = new Date(dh);
  return Number.isNaN(data.getTime()) ? null : data;
}

// Parse do AFD do iDFace (tipo 3) e, por compatibilidade, do tipo 7 do REP-P
// (que o RHiD usa). Devolve uma lista de marcacoes normalizadas.
export function parseAfdIdface(texto) {
  const linhas = String(texto || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const marcacoes = [];
  for (const linha of linhas) {
    const tipo = linha[9];
    if (!TIPOS_BATIDA.has(tipo)) continue;
    const nsr = parseInt(linha.substring(0, 9), 10);
    if (!Number.isFinite(nsr)) continue;

    let dataHora = null;
    let documento = '';
    let fuso = null;
    let sha256 = null;

    if (tipo === '3') {
      const is671 = linha.length > 14 && linha[14] === '-';
      if (is671) {
        const dh = linha.substring(10, 34);
        dataHora = dataDeDh(dh);
        fuso = fusoDeDh(dh);
        documento = extrairDocumento(linha);
      } else {
        dataHora = dataDeAfd1510(linha);
        documento = extrairDocumento(linha);
      }
    } else {
      // tipo 7 (REP-P): DH marcacao + CPF + DH gravacao + coletor + on/off + hash
      const dh = linha.substring(10, 34);
      dataHora = dataDeDh(dh);
      fuso = fusoDeDh(dh);
      documento = docNormalizado(linha.substring(34, 46));
      sha256 = linha.substring(73).replace(/[^a-fA-F0-9]/g, '').slice(0, 64) || null;
    }

    if (!dataHora) continue;
    marcacoes.push({
      nsr,
      tipoRegistro: tipo,
      deviceUserId: null,
      documento: documento || null,
      dataHora,
      dataHoraUtc: dataHora,
      fuso,
      origem: 'export_afd',
      linha,
      sha256,
    });
  }
  return marcacoes;
}

// Parse do `load_objects {object:'access_logs'}`. `time` e' epoch em segundos.
export function parseAccessLogs(json) {
  const obj = typeof json === 'string' ? safeJson(json) : json;
  const logs = Array.isArray(obj) ? obj : (obj?.access_logs || []);
  const out = [];
  for (const l of logs) {
    if (!l || typeof l !== 'object') continue;
    const epoch = Number(l.time);
    const dataHora = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : null;
    const id = Number(l.id);
    out.push({
      nsr: Number.isFinite(id) ? id : null,
      tipoRegistro: '3',
      deviceUserId: l.user_id != null ? Number(l.user_id) : null,
      documento: null,
      dataHora,
      dataHoraUtc: dataHora,
      fuso: null,
      origem: 'access_logs',
      linha: JSON.stringify(l),
      sha256: null,
    });
  }
  return out;
}

// Parse do `load_objects {object:'users'}` + `c_users` (CPF em tabela separada,
// medido no iDFace 6.26.4). Devolve um snapshot por device_user_id.
export function parseUsuarios(jsonUsers, jsonCUsers = null) {
  const users = typeof jsonUsers === 'string' ? safeJson(jsonUsers) : jsonUsers;
  const cusers = typeof jsonCUsers === 'string' ? safeJson(jsonCUsers) : jsonCUsers;
  const lista = Array.isArray(users) ? users : (users?.users || []);
  const cpfPorUser = new Map();
  for (const c of (cusers?.c_users || (Array.isArray(cusers) ? cusers : []))) {
    if (c && c.user_id != null) cpfPorUser.set(Number(c.user_id), c.cpf || null);
  }
  return lista.map((u) => ({
    deviceUserId: Number(u.id),
    registration: u.registration ?? null,
    nome: u.name ?? null,
    cpf: cpfPorUser.get(Number(u.id)) || null,
  })).filter((u) => Number.isFinite(u.deviceUserId));
}

function safeJson(v) {
  try { return JSON.parse(v); } catch { return null; }
}

// Monta o comando no formato single validado no equipamento real. O modo 671
// TEM de ir em `queryString`; `?mode=671` no endpoint devolve a UI HTML.
export function montarComando(row) {
  if (!row) return null;
  let body = row.body;
  if (typeof body === 'string') body = safeJson(body) ?? {};
  const cmd = {
    verb: row.verb || 'POST',
    endpoint: row.endpoint,
    body: body ?? {},
    contentType: row.content_type || 'application/json',
  };
  if (row.query_string) cmd.queryString = row.query_string;
  return cmd;
}

// ---------- Persistencia (pool do tenant) ----------

export async function criarDispositivo(pool, {
  nome, idEquipamento = null, portaria = '671', deviceId = null, serial = null,
} = {}) {
  const token = novoToken();
  const [res] = await pool.query(
    `INSERT INTO idface_dispositivos
      (token, device_id, serial, nome, id_Equipamento, portaria, ativo, criado_em)
     VALUES (?,?,?,?,?,?,1,NOW())`,
    [token, deviceId, serial, nome || 'iDFace', idEquipamento, portaria]
  );
  const [rows] = await pool.query('SELECT * FROM idface_dispositivos WHERE id = ?', [res.insertId]);
  return rows[0];
}

export async function listarDispositivos(pool) {
  const [rows] = await pool.query(
    `SELECT d.*,
            (SELECT COUNT(*) FROM idface_marcacoes m WHERE m.id_dispositivo = d.id) AS marcacoes,
            (SELECT COUNT(*) FROM idface_comandos c
              WHERE c.id_dispositivo = d.id AND c.status = 'pendente') AS pendentes,
            (SELECT MAX(m.data_hora) FROM idface_marcacoes m WHERE m.id_dispositivo = d.id) AS ultima_marcacao
       FROM idface_dispositivos d ORDER BY d.id DESC`
  );
  return rows;
}

export async function buscarDispositivo(pool, id) {
  const [rows] = await pool.query('SELECT * FROM idface_dispositivos WHERE id = ?', [Number(id)]);
  return rows[0] || null;
}

export async function buscarPorToken(pool, token) {
  const [rows] = await pool.query(
    'SELECT * FROM idface_dispositivos WHERE token = ? AND ativo = 1', [String(token || '')]
  );
  return rows[0] || null;
}

export async function atualizarDispositivo(pool, id, campos = {}) {
  const cols = [];
  const vals = [];
  for (const k of ['nome', 'id_Equipamento', 'portaria', 'device_id', 'serial', 'idcloud_code', 'ativo']) {
    if (campos[k] !== undefined) { cols.push(`${k} = ?`); vals.push(campos[k]); }
  }
  if (!cols.length) return buscarDispositivo(pool, id);
  vals.push(Number(id));
  await pool.query(`UPDATE idface_dispositivos SET ${cols.join(', ')} WHERE id = ?`, vals);
  return buscarDispositivo(pool, id);
}

export async function registrarPoll(pool, dispositivo, uuid) {
  await pool.query(
    `UPDATE idface_dispositivos
        SET ultimo_contato = NOW(), ultimo_uuid = ?,
            device_id = COALESCE(device_id, ?)
      WHERE id = ?`,
    [uuid || null, dispositivo.device_id || null, dispositivo.id]
  );
}

export async function enfileirarComando(pool, idDispositivo, {
  verb = 'POST', endpoint, body = {}, queryString = null, contentType = 'application/json',
} = {}) {
  const [res] = await pool.query(
    `INSERT INTO idface_comandos
      (id_dispositivo, verb, endpoint, body, query_string, content_type, status, criado_em)
     VALUES (?,?,?,?,?,?,'pendente',NOW())`,
    [Number(idDispositivo), verb, endpoint, JSON.stringify(body || {}), queryString || null, contentType]
  );
  const [rows] = await pool.query('SELECT * FROM idface_comandos WHERE id = ?', [res.insertId]);
  return rows[0];
}

export async function proximoComando(pool, idDispositivo) {
  // Se o equipamento pegou um comando e nunca reportou (offline/rede), devolve
  // para a fila depois de 5 min. Sem isso a fila trava para sempre.
  await pool.query(
    `UPDATE idface_comandos
        SET status = 'pendente', entregue_em = NULL
      WHERE id_dispositivo = ? AND status = 'entregue'
        AND entregue_em < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`,
    [Number(idDispositivo)]
  );

  const [rows] = await pool.query(
    `SELECT c.* FROM idface_comandos c
      WHERE c.id_dispositivo = ? AND c.status = 'pendente'
        AND NOT EXISTS (
          SELECT 1 FROM idface_comandos e
           WHERE e.id_dispositivo = c.id_dispositivo AND e.status = 'entregue'
        )
      ORDER BY c.id ASC LIMIT 1`,
    [Number(idDispositivo)]
  );
  if (!rows.length) return null;
  await pool.query(
    `UPDATE idface_comandos SET status = 'entregue', entregue_em = NOW() WHERE id = ?`,
    [rows[0].id]
  );
  return rows[0];
}

export async function concluirComando(pool, idDispositivo, endpoint, erro = null) {
  const [rows] = await pool.query(
    `SELECT * FROM idface_comandos
      WHERE id_dispositivo = ? AND status = 'entregue'
        AND (? IS NULL OR endpoint = ?)
      ORDER BY id ASC LIMIT 1`,
    [Number(idDispositivo), endpoint || null, endpoint || null]
  );
  if (!rows.length) return null;
  await pool.query(
    `UPDATE idface_comandos
        SET status = ?, concluido_em = NOW(), erro = ?
      WHERE id = ?`,
    [erro ? 'erro' : 'concluido', erro ? String(erro).slice(0, 255) : null, rows[0].id]
  );
  return rows[0];
}

export async function registrarResultado(pool, {
  idDispositivo, endpoint, uuid, response = null, erro = null,
} = {}) {
  const texto = response == null
    ? null
    : (typeof response === 'string' ? response : JSON.stringify(response));
  const [res] = await pool.query(
    `INSERT INTO idface_resultados (id_dispositivo, endpoint, uuid, response, erro, criado_em)
     VALUES (?,?,?,?,?,NOW())`,
    [idDispositivo, endpoint || null, uuid || null, texto, erro ? String(erro).slice(0, 255) : null]
  );
  return res.insertId;
}

export async function salvarMarcacoes(pool, idDispositivo, marcacoes = []) {
  let gravadas = 0;
  for (const m of marcacoes) {
    if (!m || !m.dataHora) continue;
    if (m.nsr == null) continue;
    try {
      await pool.query(
        `INSERT INTO idface_marcacoes
          (id_dispositivo, device_user_id, documento, nsr, data_hora, data_hora_utc,
           fuso, tipo_registro, origem, linha, sha256, criado_em)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           device_user_id = VALUES(device_user_id),
           documento = VALUES(documento),
           data_hora_utc = VALUES(data_hora_utc),
           linha = VALUES(linha)`,
        [idDispositivo, m.deviceUserId ?? null, m.documento ?? null, m.nsr,
          m.dataHora, m.dataHoraUtc || m.dataHora, m.fuso ?? null,
          m.tipoRegistro || '3', m.origem || 'export_afd', m.linha || null, m.sha256 || null]
      );
      gravadas++;
    } catch {
      // Uma linha ruim nao pode derrubar o lote inteiro.
    }
  }
  if (gravadas) await resolverDeviceUserIds(pool, idDispositivo);
  return gravadas;
}

// Liga as marcacoes do AFD (que trazem PIS/CPF) ao users.id do equipamento,
// usando o snapshot de users/c_users. Sem isso, o consumidor teria duas
// chaves diferentes para a mesma pessoa (documento x device_user_id).
export async function resolverDeviceUserIds(pool, idDispositivo) {
  try {
    await pool.query(
      `UPDATE idface_marcacoes m
         JOIN idface_usuarios u
           ON u.id_dispositivo = m.id_dispositivo
          AND (u.registration = m.documento
               OR u.cpf = m.documento
               OR CAST(u.device_user_id AS CHAR) = m.documento)
          SET m.device_user_id = u.device_user_id
        WHERE m.id_dispositivo = ? AND m.device_user_id IS NULL AND m.documento IS NOT NULL`,
      [Number(idDispositivo)]
    );
  } catch { /* snapshot ausente: o documento continua valendo */ }
}

export async function salvarUsuarios(pool, idDispositivo, usuarios = []) {
  let gravadas = 0;
  for (const u of usuarios) {
    if (!u || u.deviceUserId == null) continue;
    await pool.query(
      `INSERT INTO idface_usuarios
        (id_dispositivo, device_user_id, registration, nome, cpf, atualizado_em)
       VALUES (?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE
         registration = VALUES(registration), nome = VALUES(nome),
         cpf = COALESCE(VALUES(cpf), cpf), atualizado_em = NOW()`,
      [idDispositivo, u.deviceUserId, u.registration ?? null, u.nome ?? null, u.cpf ?? null]
    );
    gravadas++;
  }
  return gravadas;
}

export async function listarMarcacoes(pool, {
  idDispositivo = null, documento = null, dataInicio = null, dataFim = null, limite = 1000,
} = {}) {
  let sql = `SELECT m.id, m.id_dispositivo, m.device_user_id, m.documento, m.nsr,
                    m.data_hora, m.data_hora_utc, m.fuso, m.tipo_registro,
                    m.origem, m.criado_em,
                    u.registration AS usuario_registration,
                    u.nome AS usuario_nome,
                    u.cpf AS usuario_cpf,
                    v.id_pessoa
               FROM idface_marcacoes m
               LEFT JOIN idface_usuarios u
                 ON u.id_dispositivo = m.id_dispositivo
                AND u.device_user_id = m.device_user_id
               LEFT JOIN idface_vinculos v
                 ON v.id_dispositivo = m.id_dispositivo
                AND v.device_user_id = m.device_user_id
                AND v.valid_to IS NULL
              WHERE 1=1`;
  const params = [];
  if (idDispositivo) { sql += ' AND m.id_dispositivo = ?'; params.push(idDispositivo); }
  if (documento) { sql += ' AND m.documento = ?'; params.push(documento); }
  if (dataInicio) { sql += ' AND m.data_hora >= ?'; params.push(dataInicio); }
  if (dataFim) { sql += ' AND m.data_hora <= ?'; params.push(dataFim); }
  sql += ' ORDER BY m.data_hora ASC, m.nsr ASC LIMIT ?';
  params.push(Math.min(Number(limite) || 1000, 5000));
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function listarUsuarios(pool, idDispositivo) {
  const [rows] = await pool.query(
    `SELECT * FROM idface_usuarios WHERE id_dispositivo = ? ORDER BY nome ASC`,
    [Number(idDispositivo)]
  );
  return rows;
}

// Vinculo versionado. Fecha o vigente do mesmo device_user_id e abre o novo.
export async function vincularUsuario(pool, {
  idDispositivo, deviceUserId, idPessoa = null, documento = null, origem = 'manual',
} = {}) {
  await pool.query(
    `UPDATE idface_vinculos SET valid_to = NOW()
      WHERE id_dispositivo = ? AND device_user_id = ? AND valid_to IS NULL`,
    [Number(idDispositivo), Number(deviceUserId)]
  );
  const [res] = await pool.query(
    `INSERT INTO idface_vinculos
      (id_dispositivo, device_user_id, id_pessoa, documento, valid_from, origem)
     VALUES (?,?,?,?,NOW(),?)`,
    [Number(idDispositivo), Number(deviceUserId), idPessoa, documento, origem]
  );
  const [rows] = await pool.query('SELECT * FROM idface_vinculos WHERE id = ?', [res.insertId]);
  return rows[0];
}

export async function listarVinculos(pool, idDispositivo) {
  const [rows] = await pool.query(
    `SELECT * FROM idface_vinculos WHERE id_dispositivo = ? ORDER BY valid_from DESC`,
    [Number(idDispositivo)]
  );
  return rows;
}

// Processa o `/result` de acordo com o comando que estava pendente. Devolve um
// resumo para a rota e para os logs. `salvarArquivo` e' injetado para nao
// acoplar este modulo ao afdStore (e ao filesystem nos testes).
export async function processarResultado(pool, {
  schema, dispositivo, comando, endpoint, response, erro, salvarArquivo,
} = {}) {
  const resumo = { endpoint, marcacoes: 0, usuarios: 0, arquivo: null, sistema: false };
  if (erro) return resumo;

  const cmdBody = comando && typeof comando.body === 'string'
    ? safeJson(comando.body) : (comando?.body || {});

  if (endpoint === 'export_afd') {
    const texto = typeof response === 'string' ? response : (response?.afd || response?.raw || '');
    const primeira = String(texto).split(/\r?\n/).find((l) => l[9] === '3');
    const formato = (comando?.query_string === 'mode=671' || (primeira && primeira[14] === '-'))
      ? '671' : '595';
    const marcacoes = parseAfdIdface(texto);
    resumo.marcacoes = await salvarMarcacoes(pool, dispositivo.id, marcacoes);
    if (salvarArquivo && texto) {
      const nsrs = marcacoes.map((m) => m.nsr).filter(Number.isFinite);
      resumo.arquivo = await salvarArquivo({
        schema,
        origem: 'idface',
        formato,
        serial: dispositivo.serial,
        idDispositivo: dispositivo.id,
        texto,
        nsrInicial: nsrs.length ? Math.min(...nsrs) : null,
        nsrFinal: nsrs.length ? Math.max(...nsrs) : null,
      });
    }
    return resumo;
  }

  if (endpoint === 'load_objects') {
    const object = cmdBody?.object;
    if (object === 'access_logs') {
      resumo.marcacoes = await salvarMarcacoes(
        pool, dispositivo.id, parseAccessLogs(response)
      );
    } else if (object === 'users') {
      resumo.usuarios = await salvarUsuarios(
        pool, dispositivo.id, parseUsuarios(response)
      );
    } else if (object === 'c_users') {
      // O CPF fica em c_users no iDFace. Upsert direto: o comando de c_users
      // pode chegar antes do snapshot de users.
      const obj = typeof response === 'string' ? safeJson(response) : response;
      for (const c of (obj?.c_users || [])) {
        if (c?.user_id == null) continue;
        await pool.query(
          `INSERT INTO idface_usuarios
            (id_dispositivo, device_user_id, cpf, atualizado_em)
           VALUES (?,?,?,NOW())
           ON DUPLICATE KEY UPDATE cpf = VALUES(cpf), atualizado_em = NOW()`,
          [dispositivo.id, Number(c.user_id), c.cpf || null]
        );
      }
    }
    return resumo;
  }

  if (endpoint === 'system_information') {
    const info = typeof response === 'string' ? safeJson(response) : response;
    if (info) {
      await pool.query(
        `UPDATE idface_dispositivos
            SET serial = COALESCE(?, serial),
                device_id = COALESCE(?, device_id),
                idcloud_code = COALESCE(?, idcloud_code)
          WHERE id = ?`,
        [info.serial || null, info.device_id || null, info.iDCloud_code || info.idcloud_code || null, dispositivo.id]
      );
      resumo.sistema = true;
    }
    return resumo;
  }

  return resumo;
}
