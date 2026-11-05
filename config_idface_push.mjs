// config_idface_push.mjs — configura (ou só mostra) o push do iDFace local.
//
// Uso:
//   node config_idface_push.mjs 192.168.100.138 --show
//   node config_idface_push.mjs 192.168.100.138 https://SEU_HOST/api/idface/tenant_0001/TOKEN
//
// Opcionais:
//   --period=10       segundos entre polls (padrao 10; use 300 em producao)
//   --timeout=30000   timeout de cada request (padrao 30000)
//   --user=admin --pass=admin
//
// O firmware acrescenta /push e /result na URL configurada; por isso a URL
// passada aqui deve ser a BASE (sem /push).
import http from 'node:http';

const args = process.argv.slice(2);
const IP = args.find((a) => !a.startsWith('--')) || process.env.IDFACE_IP;
const URL_ARG = args.filter((a) => !a.startsWith('--'))[1] || null;
const SHOW = args.includes('--show');
const getArg = (nome, padrao) => {
  const a = args.find((x) => x.startsWith(`--${nome}=`));
  return a ? a.split('=')[1] : padrao;
};
const PORT = Number(getArg('port', process.env.IDFACE_PORT || 80));
const USER = getArg('user', process.env.IDFACE_USER || 'admin');
const PASS = getArg('pass', process.env.IDFACE_PASS || 'admin');
const PERIOD = String(getArg('period', '10'));
const TIMEOUT = String(getArg('timeout', '30000'));

if (!IP) {
  console.error('Uso: node config_idface_push.mjs <IP> <URL_BASE> [--period=10] [--timeout=30000]');
  console.error('     node config_idface_push.mjs <IP> --show');
  process.exit(1);
}

function call(cmd, data = {}, session) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(data);
    const q = session ? `?session=${encodeURIComponent(session)}` : '';
    const req = http.request({
      hostname: IP, port: PORT, path: `/${cmd}.fcgi${q}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) },
      timeout: 30000,
    }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const body = Buffer.concat(c).toString('utf8');
        let json = null;
        try { json = JSON.parse(body); } catch { /* html de erro */ }
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(b);
    req.end();
  });
}

function mostrar(cfg) {
  const p = cfg?.push_server || {};
  console.log('  push_remote_address:', p.push_remote_address ?? '(vazio)');
  console.log('  push_request_timeout:', p.push_request_timeout ?? '(vazio)');
  console.log('  push_request_period:', p.push_request_period ?? '(vazio)');
}

const login = await call('login', { login: USER, password: PASS });
if (!login.json?.session) {
  console.error('Login falhou:', login.status, login.body.slice(0, 300));
  process.exit(1);
}
const session = login.json.session;

const antes = await call('get_configuration', {
  push_server: ['push_remote_address', 'push_request_timeout', 'push_request_period'],
}, session);
console.log(`\nConfiguracao atual do iDFace ${IP}:`);
mostrar(antes.json);

if (SHOW || !URL_ARG) {
  if (!URL_ARG) {
    console.log('\nNada foi alterado. Para configurar, rode:');
    console.log(`  node config_idface_push.mjs ${IP} https://SEU_HOST/api/idface/SEU_TENANT/SEU_TOKEN`);
  }
  process.exit(0);
}

if (!/^https?:\/\//i.test(URL_ARG)) {
  console.error('\nA URL precisa comecar com http:// ou https://');
  process.exit(1);
}

const r = await call('set_configuration', {
  push_server: {
    push_remote_address: URL_ARG,
    push_request_timeout: TIMEOUT,
    push_request_period: PERIOD,
  },
}, session);
if (r.status !== 200) {
  console.error('\nFalha ao configurar:', r.status, r.body.slice(0, 500));
  process.exit(1);
}

const depois = await call('get_configuration', {
  push_server: ['push_remote_address', 'push_request_timeout', 'push_request_period'],
}, session);
console.log('\nConfiguracao depois:');
mostrar(depois.json);
console.log(`\nOK. O iDFace vai chamar ${URL_ARG}/push a cada ${PERIOD}s.`);
console.log('Para reverter, rode de novo com a URL antiga (ex.: https://izcloud.com.br --period=300).');
