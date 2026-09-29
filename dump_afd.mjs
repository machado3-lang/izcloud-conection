// Baixa um AFD maior pelo canal iDCloud e mostra a distribuicao de tipos, para
// descobrir o layout real dos registros deste aparelho.
//   node dump_afd.mjs [limite]
import fs from 'fs';
import https from 'https';
import { criarServidor, reservarVaga, baixarAfd } from './idcloudServer.js';

const REP = '192.168.100.132';
const PORTA_FCGI = Number(process.env.REP_PORTA || 5432);
const LIM = Number(process.argv[2] || 200);

function fcgi(comando, dados = {}) {
  return new Promise((ok, no) => {
    const corpo = JSON.stringify(dados);
    const i = comando.indexOf('?');
    const path = i >= 0 ? `/${comando.slice(0, i)}.fcgi${comando.slice(i)}` : `/${comando}.fcgi`;
    const r = https.request({ hostname: REP, port: PORTA_FCGI, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
      rejectUnauthorized: false, insecureHTTPParser: true, timeout: 15000 },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => ok(b)); });
    r.on('error', no);
    r.on('timeout', () => { r.destroy(); no(new Error('timeout')); });
    r.write(corpo); r.end();
  });
}

let pronto = null;
reservarVaga(1, 10);
const srv = await criarServidor({
  cert: fs.readFileSync('cert.pem'), key: fs.readFileSync('chave.pem'),
  porta: 443, host: '192.168.100.179',
  aoConectar: async (ctx) => {
    const { texto } = await baixarAfd(ctx, { limite: LIM, offset: 0 });
    fs.writeFileSync('afd_recebido.txt', texto);
    pronto = texto;
  },
});

const sess = JSON.parse(await fcgi('login', { login: 'admin', password: 'admin' })).session;
await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: 8 });
const t0 = Date.now();
while (Date.now() - t0 < 90000 && !pronto) await new Promise((r) => setTimeout(r, 1500));
await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: 2078000 });
srv.close();

if (!pronto) { console.log('nenhum AFD'); process.exit(1); }
const linhas = pronto.split(/\r?\n/).filter((l) => l.trim());
console.log(`AFD: ${linhas.length} linhas, ${pronto.length} bytes\n`);

const hist = {};
for (const l of linhas) { const t = l.length > 9 ? l[9] : '?'; hist[t] = (hist[t] || 0) + 1; }
console.log('tipo na posicao 9: ' + JSON.stringify(hist));

for (const t of Object.keys(hist)) {
  const exemplo = linhas.find((l) => l.length > 9 && l[9] === t);
  console.log(`\n=== tipo ${t}  (${hist[t]} linhas)  tamanho ${exemplo.length}`);
  console.log('  ' + exemplo);
  for (let i = 0; i < Math.min(exemplo.length, 60); i += 10) {
    console.log(`    ${String(i).padStart(2)}: ${exemplo.substr(i, 10)}`);
  }
}
console.log('\nultimas 2 linhas:');
linhas.slice(-2).forEach((l) => console.log('  ' + l));
process.exit(0);
