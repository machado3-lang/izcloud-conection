// test_idface_dump.mjs — dump SOMENTE LEITURA do iDFace para comparar
// antes/depois da configuração no RHiD da ControlID.
//
//   node test_idface_dump.mjs 192.168.100.138 80
//
// Gera idface_dump_<timestamp>.json com:
// system_information, configuração (modo/push/monitor), users, c_users,
// custom_columns, access_logs e os AFDs 595/671. NÃO altera nada.
import http from 'node:http';
import fs from 'node:fs';

const IP = process.argv[2] || process.env.IDFACE_IP;
const PORT = Number(process.argv[3] || process.env.IDFACE_PORT || 80);
const USER = process.argv[4] || process.env.IDFACE_USER || 'admin';
const PASS = process.argv[5] || process.env.IDFACE_PASS || 'admin';
if (!IP) {
  console.error('Uso: node test_idface_dump.mjs <IP> [porta] [usuario] [senha]');
  process.exit(1);
}

function call(cmd, data = {}, session, extra = '') {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(data);
    let q = '';
    if (session) q += `?session=${encodeURIComponent(session)}`;
    if (extra) q += (q ? '&' : '?') + extra;
    const req = http.request({ hostname: IP, port: PORT, path: `/${cmd}.fcgi${q}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }, timeout: 60000 },
      (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
      });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(b); req.end();
  });
}

const login = JSON.parse((await call('login', { login: USER, password: PASS })).body);
const session = login.session;
if (!session) { console.error('login sem session'); process.exit(1); }

const dump = {
  gerado_em: new Date().toISOString(),
  ip: IP,
  porta: PORT,
  system_information: JSON.parse((await call('system_information', {}, session)).body),
  config: JSON.parse((await call('get_configuration', {
    general: ['attendance_mode', 'ssl_enabled'],
    push_server: ['push_remote_address', 'push_request_timeout', 'push_request_period'],
    monitor: ['hostname', 'port', 'path', 'request_timeout', 'alive_interval'],
  }, session)).body),
  users: JSON.parse((await call('load_objects', { object: 'users', limit: 100, offset: 0 }, session)).body),
  c_users: JSON.parse((await call('load_objects', { object: 'c_users', limit: 100, offset: 0 }, session)).body),
  custom_columns: JSON.parse((await call('load_objects', { object: 'custom_columns', limit: 100, offset: 0 }, session)).body),
  access_logs: JSON.parse((await call('load_objects', { object: 'access_logs', limit: 1000, offset: 0 }, session)).body),
  afd_595: (await call('export_afd', {}, session)).body,
  afd_671: (await call('export_afd', {}, session, 'mode=671')).body,
};

const nome = `idface_dump_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(nome, JSON.stringify(dump, null, 2), 'utf-8');
console.log('dump salvo:', nome);
console.log('users:', dump.users.users?.length ?? 0,
  'c_users:', dump.c_users.c_users?.length ?? 0,
  'access_logs:', dump.access_logs.access_logs?.length ?? 0);
console.log('AFD 595/671 bytes:', dump.afd_595.length, '/', dump.afd_671.length);
