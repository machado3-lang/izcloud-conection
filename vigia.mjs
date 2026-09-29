// Ajusta o intervalo do iDCloud no REP e fica de olho na captura local ate o
// REP aparecer (ou o tempo acabar).   node vigia.mjs [intervalo] [segundos]
import https from 'https';
import fs from 'fs';

const REP = '192.168.100.132';
const MEU_IP = '192.168.100.179';
const LOG = 'captura_rep.log';
const INTERVALO = Number(process.argv[2] || 15);
const ESPERA_S = Number(process.argv[3] || 150);

function fcgi(comando, dados = {}) {
  return new Promise((resolve, reject) => {
    const corpo = JSON.stringify(dados);
    const i = comando.indexOf('?');
    const path = i >= 0 ? `/${comando.slice(0, i)}.fcgi${comando.slice(i)}` : `/${comando}.fcgi`;
    const req = https.request({ hostname: REP, port: 443, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
      rejectUnauthorized: false, insecureHTTPParser: true, timeout: 20000 },
      (res) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => resolve(Buffer.concat(b).toString())); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(corpo); req.end();
  });
}

const sess = JSON.parse(await fcgi('login', { login: 'admin', password: 'admin' })).session;
const antes = await fcgi(`get_idcloud?session=${sess}`);
console.log('antes: ' + antes);

const marca = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8').length : 0;
console.log(`\naplicando interval=${INTERVALO} ...`);
console.log('  -> ' + (await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: INTERVALO })).slice(0, 120));
console.log('estado: ' + (await fcgi(`get_idcloud?session=${sess}`)) + '\n');

console.log(`vigiando ${LOG} por ${ESPERA_S}s (procuro conexao vinda de ${REP})...`);
const t0 = Date.now();
let conexao = false;
while (Date.now() - t0 < ESPERA_S * 1000) {
  await new Promise((r) => setTimeout(r, 2000));
  const txt = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8').slice(marca) : '';
  if (/CONEXAO RECEBIDA/.test(txt)) { conexao = true; break; }
  process.stdout.write('.');
}
console.log('');

const txt = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8').slice(marca) : '';
if (conexao) {
  console.log('\n*** CHEGOU CONEXAO ***\n');
  console.log(txt.slice(0, 6000));
} else {
  console.log('\nnada chegou em ' + ESPERA_S + 's.');
  console.log('estado do REP agora: ' + (await fcgi(`get_system_information?session=${sess}`)).slice(0, 200));
}

console.log('\nrestaurando interval=2078000');
console.log('  -> ' + (await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: 2078000 })).slice(0, 80));
console.log('estado: ' + (await fcgi(`get_idcloud?session=${sess}`)));
process.exit(0);
