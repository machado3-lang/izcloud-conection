// test_idface.mjs — diagnostico SOMENTE LEITURA de um iDFace.
//
//   node test_idface.mjs <IP> [porta] [usuario] [senha]
//   IDFACE_IP=192.168.100.138 IDFACE_PORT=80 node test_idface.mjs
//
// Faz login, le system_information, configuracao (modo ponto / push / monitor),
// usuarios, access_logs e exporta o AFD 595 (PIS) e 671 (CPF) para conferir
// formato/contagem. NAO altera a configuracao do aparelho.
import http from 'node:http';
import https from 'node:https';

const IP = process.argv[2] || process.env.IDFACE_IP;
const PORT = Number(process.argv[3] || process.env.IDFACE_PORT || 80);
const USER = process.argv[4] || process.env.IDFACE_USER || 'admin';
const PASS = process.argv[5] || process.env.IDFACE_PASS || 'admin';

if (!IP) {
  console.error('Uso: node test_idface.mjs <IP> [porta] [usuario] [senha]');
  process.exit(1);
}

const log = (...a) => console.log(...a);

function fcgi(protocol, ip, porta, path, dados, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const corpo = JSON.stringify(dados || {});
    const mod = protocol === 'http' ? http : https;
    const opts = {
      hostname: ip, port: porta, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
      timeout, rejectUnauthorized: false,
    };
    if (protocol === 'https') opts.insecureHTTPParser = true;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(corpo); req.end();
  });
}

async function chamar(comando, dados = {}, { session, timeout, extra } = {}) {
  let q = '';
  if (session) q += `?session=${encodeURIComponent(session)}`;
  if (extra) q += (q ? '&' : '?') + extra;
  const path = `/${comando}.fcgi${q}`;
  let erro = null;
  for (const protocolo of ['https', 'http']) {
    try {
      const r = await fcgi(protocolo, IP, PORT, path, dados, timeout);
      let json = null;
      try { json = JSON.parse(r.body.toString('utf8')); } catch { /* binario/texto */ }
      return { protocolo, ...r, json };
    } catch (e) { erro = e; }
  }
  throw erro || new Error('sem resposta');
}

function resumo(rotulo, r) {
  const tipo = r.json ? 'json' : 'texto/binario';
  log(`\n[${rotulo}] ${r.protocolo.toUpperCase()} status=${r.status} bytes=${r.body.length} (${tipo})`);
  if (r.json) log('  ' + JSON.stringify(r.json).slice(0, 1500));
  else log('  ' + r.body.toString('latin1', 0, 300).replace(/\s+/g, ' '));
}

function resumoAFD(rotulo, body) {
  const txt = body.toString('latin1');
  const linhas = txt.split(/\r?\n/).filter((l) => l.trim());
  const tipos = {};
  for (const l of linhas) tipos[l[9] || '?'] = (tipos[l[9] || '?'] || 0) + 1;
  const batidas = linhas.filter((l) => l[9] === '3');
  log(`\n[export_afd ${rotulo}] bytes=${body.length} linhas=${linhas.length} batidas=${batidas.length}`);
  log('  tipos:', JSON.stringify(tipos));
  log('  1a linha:', (linhas[0] || '').slice(0, 90));
  log('  ultima:  ', (linhas.at(-1) || '').slice(0, 90));
  if (batidas[0]) log('  1a batida:', batidas[0].slice(0, 90));
  if (batidas.at(-1)) log('  ultima batida:', batidas.at(-1).slice(0, 90));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  log(`Conectando em ${IP}:${PORT} ...`);

  let login = await chamar('login', { login: USER, password: PASS });
  let session = login.json?.session || login.json?.session_id || null;
  if (!session) {
    login = await chamar('login', { name: USER, password: PASS });
    session = login.json?.session || login.json?.session_id || null;
  }
  resumo('login', login);
  if (!session) {
    console.error('\nLogin nao devolveu session; o diagnostico para aqui.');
    process.exit(1);
  }
  log(`\nSessao: ${session}`);

  // system_information: serial, device_id, iDCloud_code, firmware, modo
  const info = await chamar('system_information', {}, { session });
  if (info.json) {
    log('\n[system_information] resumo:');
    log('  serial:        ', info.json.serial);
    log('  firmware:      ', info.json.version);
    log('  device_id:     ', info.json.device_id);
    log('  iDCloud_code:  ', info.json.iDCloud_code);
    log('  device_name:   ', info.json.device_name);
    log('  network:       ', JSON.stringify(info.json.network));
  } else {
    resumo('system_information', info);
  }

  // configuracao: modo ponto, push e monitor
  try {
    const cfg = await chamar('get_configuration', {
      general: ['attendance_mode', 'ssl_enabled'],
      push_server: ['push_remote_address', 'push_request_timeout', 'push_request_period'],
      monitor: ['hostname', 'port', 'path', 'request_timeout', 'alive_interval'],
    }, { session });
    resumo('get_configuration', cfg);
    if (cfg.json) {
      const gp = cfg.json.general || {};
      log('\n  Modo ponto:', String(gp.attendance_mode) === '1' ? 'SIM' : 'nao/desconhecido',
        '(attendance_mode=' + gp.attendance_mode + ', ssl_enabled=' + gp.ssl_enabled + ')');
      if (cfg.json.push_server) log('  push_server:', JSON.stringify(cfg.json.push_server));
      if (cfg.json.monitor) log('  monitor:', JSON.stringify(cfg.json.monitor));
    }
  } catch (e) { log('\n[get_configuration] ERRO: ' + e.message); }

  // usuarios
  try {
    const users = await chamar('load_objects', { object: 'users', limit: 100 }, { session });
    const lista = users.json?.users || [];
    log(`\n[load_objects users] usuarios=${lista.length} (count=${users.json?.count ?? '-'})`);
    if (lista[0]) log('  1o:', JSON.stringify(lista[0]).slice(0, 500));
  } catch (e) { log('\n[load_objects users] ERRO: ' + e.message); }

  // Campos customizados: no iDFace o CPF fica em c_users.cpf, enquanto o PIS
  // fica em users.registration. O AFD usa users.id (não usa nenhum dos dois).
  try {
    const cUsers = await chamar('load_objects', { object: 'c_users', limit: 100, offset: 0 }, { session });
    const cols = await chamar('load_objects', { object: 'custom_columns', limit: 100, offset: 0 }, { session });
    log('\n[load_objects c_users]');
    log('  ' + JSON.stringify(cUsers.json).slice(0, 1500));
    log('  custom_columns: ' + JSON.stringify(cols.json).slice(0, 1200));
  } catch (e) { log('\n[load_objects c_users] ERRO: ' + e.message); }

  // access_logs (sem order; a API rejeita order objeto)
  try {
    const logs = await chamar('load_objects', { object: 'access_logs', limit: 5, offset: 0 }, { session });
    const arr = logs.json?.access_logs || [];
    log(`\n[load_objects access_logs] logs=${arr.length}`);
    for (const l of arr.slice(0, 3)) log('  ' + JSON.stringify(l).slice(0, 600));
  } catch (e) { log('\n[load_objects access_logs] ERRO: ' + e.message); }

  // AFD: 595 (sem mode) e 671 (mode=671)
  for (const [rotulo, extra] of [['595 (PIS)', ''], ['671 (CPF)', 'mode=671']]) {
    try {
      const r = await chamar('export_afd', {}, { session, extra, timeout: 120000 });
      resumoAFD(rotulo, r.body);
    } catch (e) { log(`\n[export_afd ${rotulo}] ERRO: ${e.message}`); }
  }

  log('\nDiagnostico concluido (nada foi alterado no equipamento).');
  process.exit(0);
} catch (e) {
  console.error('\nFalha no diagnostico:', e.message);
  process.exit(1);
}
