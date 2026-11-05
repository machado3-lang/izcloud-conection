// repClient.js — Cliente FCGI dos REPs 1510/671 (portado do ponto-cloud/server.js)
// Este e o "motor" de comunicacao com o REP via IP (HTTPS com fallback HTTP).
// Substitui o stub DeviceCommunicationService do projeto .NET.
import https from 'https';
import http from 'http';

function proxyREPComProtocolo(protocol, ip, porta, comando, dados) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(dados || {});
    const port = porta || 443;
    const qsIdx = comando.indexOf('?');
    const path = qsIdx >= 0 ? `/${comando.slice(0, qsIdx)}.fcgi${comando.slice(qsIdx)}` : `/${comando}.fcgi`;
    const mod = protocol === 'http' ? http : https;
    const opts = {
      hostname: ip, port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: comando.startsWith('get_afd') ? 60000 : 10000, rejectUnauthorized: false,
    };
    if (protocol === 'https') opts.insecureHTTPParser = true;
    const req = mod.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); }
      });
    });
    req.on('error', (e) => reject(e.message));
    req.on('timeout', () => { req.destroy(); reject('Timeout'); });
    req.write(data);
    req.end();
  });
}

export async function proxyREP(ip, porta, comando, dados) {
  try {
    return await proxyREPComProtocolo('https', ip, porta, comando, dados);
  } catch (err) {
    const s = String(err);
    if (s.includes('ECONNRESET') || s.includes('SSL') || s.includes('tls') || s.includes('protocol') || s.includes('Parse Error') || s.includes('socket'))
      return await proxyREPComProtocolo('http', ip, porta, comando, dados);
    throw new Error(String(err));
  }
}

async function login(ip, porta, usuario = 'admin', senha = 'admin') {
  const r = await proxyREP(ip, porta, 'login', { login: usuario, password: senha });
  if (!r?.session) throw new Error('Falha no login do REP');
  return r.session;
}

// Auto-detecta 1510/671 via get_configuration (usado no cadastro)
export async function probe(ip, porta, usuario, senha) {
  const sess = await login(ip, porta, usuario, senha);
  const [about, info] = await Promise.all([
    proxyREP(ip, porta, 'get_about', { session: sess }).catch(() => ({})),
    proxyREP(ip, porta, 'get_info', { session: sess }).catch(() => ({})),
  ]);
  // Deteccao DEFINITIVA 1510/671 via get_afd?mode=671 (cai no fallback manual se nao detectar)
  const portaria = await detectarTipoRepSession(sess, ip, porta);
  return {
    conectado: true, sessao: sess,
    modelo: about.model || about.nSerie || '',
    serial: about.nSerie || '',
    // A API devolve o firmware em DECIMAL; o display do REP mostra o mesmo
    // valor em HEX. Ex.: versionFW=1048 -> 0x418 -> display "418".
    firmware: about.versionFW || '',
    firmwareHex: about.versionFW ? '0x' + Number(about.versionFW).toString(16).toUpperCase() : '',
    firmwareDisplay: about.versionFW ? Number(about.versionFW).toString(16).toUpperCase() : '',
    mrp: about.versionMRP || '',
    mrpDisplay: about.versionMRP ? Number(about.versionMRP).toString(16).toUpperCase() : '',
    isFacial: !!about.isFacial,
    portaria,                                  // '1510' | '671' | null (null => usuario informa)
    usuarios: info.user_count ?? null,
    templates: info.template_count ?? null,
  };
}

// Envia usuarios para a memoria do REP. 1510 -> PIS; 671 -> CPF.
// Cada usuario pode trazer templates biometricos: u.templates = [{template, finger, type}]
// e/ou faces: u.facial = [{faceTemplate}]. Enviados junto no add_users (quando o firmware aceita).
export async function enviarUsuarios(ip, porta, usuarios, portaria, usuario = 'admin', senha = 'admin') {
  const sess = await login(ip, porta, usuario, senha);
  const sessEnc = encodeURIComponent(sess);
  const qs = portaria === '671' ? `?session=${sessEnc}&mode=671` : `?session=${sessEnc}`;
  const idField = portaria === '1510' ? 'pis' : 'cpf';
  const payload = usuarios
    .map((u) => {
      // O cadastro manual na UI manda `matricula`/`senha`; o import do REP usa
      // `registration`/`password`. Normalizar aqui evita mandar 0/1234 no lugar
      // do que o operador digitou.
      const matricula = u.registration ?? u.matricula ?? 0;
      const codigo = u.code ?? u.codigo ?? matricula;
      const documento = u[idField] ?? matricula;
      const obj = {
        [idField]: parseInt(String(documento).replace(/\D/g, '') || '0'),
        name: u.name || u.nome || '',
        registration: parseInt(String(matricula).replace(/\D/g, '') || '0'),
        code: parseInt(String(codigo).replace(/\D/g, '') || '0'),
        password: String(u.password || u.senha || '1234'),
      };
      if (Array.isArray(u.templates) && u.templates.length) obj.templates = u.templates;
      if (Array.isArray(u.facial) && u.facial.length) obj.facial = u.facial;
      return obj;
    })
    .filter((u) => u[idField] > 0);
  if (payload.length === 0) throw new Error('Nenhum usuario com PIS/CPF valido');
  const r = await proxyREP(ip, porta, `add_users${qs}`, { users: payload });
  return r;
}

// Le usuarios (e biometria) da memoria do REP.
//
// Medido no REP real (v1048): `load_users` EXIGE `limit` e `offset` inteiros e
// o teto de `limit` e 100. Sem isso o aparelho responde
// "'limit' deve ser do tipo inteiro". `templates: true` devolve os templates
// base64 (o padrao so devolve `templates_count`). A resposta traz `count` com o
// total, entao paginamos ate acabar.
export async function lerUsuarios(ip, porta, usuario = 'admin', senha = 'admin', { templates = true, limite = 100 } = {}) {
  const sess = await login(ip, porta, usuario, senha);
  const todos = [];
  let offset = 0;
  let total = null;

  for (let pagina = 0; pagina < 1000; pagina++) {
    const corpo = { session: sess, limit: limite, offset };
    if (templates) corpo.templates = true;
    const r = await proxyREP(ip, porta, 'load_users', corpo).catch(() => null);
    const users = r?.users || (Array.isArray(r) ? r : []);
    if (!users.length) break;
    todos.push(...users);
    total = Number(r?.count ?? total ?? todos.length);
    offset += users.length;
    if (users.length < limite || offset >= total) break;
  }

  if (todos.length) return todos;

  // Firmware antigo que nao aceita limit/offset: tenta o comando legado.
  const r = await proxyREP(ip, porta, 'get_users', { session: sess }).catch(() => null);
  return r?.users || (Array.isArray(r) ? r : []);
}

// Le a empresa/empregador gravada na memoria do REP (load_company).
export async function lerEmpresa(ip, porta, usuario = 'admin', senha = 'admin') {
  const sess = await login(ip, porta, usuario, senha);
  const r = await proxyREP(ip, porta, 'load_company', { session: sess });
  return r?.company || null;
}

// Mapeia um usuario cru do REP para o formato interno, de forma defensiva.
//
// No firmware real os templates vem como array de STRINGS base64 (um por
// digital), nao como objetos `{template, finger}`. O indice nao vem no payload;
// usamos a ordem (1..N) e o envio posterior pode ser ajustado se o aparelho
// reclamar. O `pis`/`cpf` numerico e o documento; `code`, `registration`,
// `rfid`, `bars` e `admin` completam o cadastro que ja existe no REP.
export function mapearUsuario(u) {
  const pis = u.pis != null ? String(u.pis) : null;
  const cpf = u.cpf != null ? String(u.cpf) : null;
  const tipo = cpf ? '671' : '1510';
  const nome = u.name || u.nome || '';
  const templates = (u.templates || []).map((t, i) => {
    if (typeof t === 'string') return { tipo: 'digital', indice: i + 1, dados: t };
    return {
      tipo: 'digital',
      indice: t.finger != null ? t.finger : (t.indice != null ? t.indice : i + 1),
      dados: t.template != null ? t.template : (t.data != null ? t.data : (t.dados != null ? t.dados : '')),
    };
  });
  const faces = (u.facial || u.faces || u.faceTemplates || []).map((f, i) => {
    if (typeof f === 'string') return { tipo: 'face', indice: i, dados: f };
    return {
      tipo: 'face',
      indice: i,
      dados: f.faceTemplate != null ? f.faceTemplate : (f.template != null ? f.template : (f.data != null ? f.data : '')),
    };
  });
  return {
    pis,
    cpf,
    nome,
    tipo,
    codigo: u.code != null ? Number(u.code) : null,
    matricula: u.registration != null ? Number(u.registration) : null,
    senha: u.password || null,
    admin: !!u.admin,
    rfid: u.rfid != null && Number(u.rfid) !== 0 ? String(u.rfid) : null,
    barras: u.bars || null,
    templates: [...templates, ...faces].filter((t) => t.dados),
  };
}

export async function baixarAfd(ip, porta, dataInicio, dataFim, usuario = 'admin', senha = 'admin', mode) {
  const sess = await login(ip, porta, usuario, senha);
  const qs = mode === '671' ? '?mode=671' : '';
  const body1 = { session: sess };
  if (dataInicio) {
    body1.data_inicio = dataInicio;            // firmwares antigos (ex.: 1048)
    body1.data_fim = dataFim || dataInicio;
  }
  let r = await proxyREP(ip, porta, 'get_afd' + qs, body1);
  // fallback p/ firmwares 671 que usam initial_date em vez de data_inicio
  if (!(r?.afd || r?.raw) && dataInicio) {
    const [y, m, d] = dataInicio.split('-');
    const body2 = { ...body1, initial_date: { year: +y, month: +m, day: +d } };
    r = await proxyREP(ip, porta, 'get_afd' + qs, body2);
  }
  if (r?.afd || r?.raw) return r.afd || r.raw;
  throw new Error('AFD nao retornado pelo REP');
}

// Deteccao DEFINITIVA 1510/671: pede AFD em mode=671 e inspeciona a linha tipo '3'.
// Se pos14 == '-' (ISO) => 671; se voltar 1510 ou der erro => 1510 (nao suporta 671).
export async function detectarTipoRepSession(sess, ip, porta) {
  const fim = new Date();
  const ini = new Date(fim.getTime() - 30 * 86400000);
  const fmt = (dt) => dt.toISOString().slice(0, 10);
  const bodyBase = { session: sess, data_inicio: fmt(ini), data_fim: fmt(fim) };

  // 1) tenta mode=671 (REP 671 devolve ISO com '-' na pos14)
  try {
    const r = await proxyREP(ip, porta, 'get_afd?mode=671', bodyBase);
    const t = primeiraBatida(r);
    if (t) return t[14] === '-' ? '671' : '1510';
  } catch { /* 1510 nao suporta mode=671 */ }

  // 2) fallback legacy (sem mode)
  try {
    const r = await proxyREP(ip, porta, 'get_afd', bodyBase);
    const t = primeiraBatida(r);
    if (t) return t[14] === '-' ? '671' : '1510';
  } catch {}
  return null; // nao detectado -> usuario informa manualmente
}

function primeiraBatida(r) {
  const txt = r?.afd || r?.raw;
  if (!txt) return null;
  return String(txt).split(/\r?\n/).map(l => l.trim()).filter(Boolean).find(l => l[9] === '3') || null;
}


