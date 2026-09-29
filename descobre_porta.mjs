// Descobre em que porta o REP disca o canal iDCloud: escuta 443 E 5432 ao
// mesmo tempo e aplica a sequencia FCGI em qualquer das duas que responder.
//
//   node descobre_porta.mjs [intervalo] [segundos]
import tls from 'tls';
import fs from 'fs';
import https from 'https';

const MEU = '192.168.100.179';
const REP = '192.168.100.132';
const REP_PORTA = Number(process.env.REP_PORTA || 5432);
const INTERVALO = Number(process.argv[2] || 8);
const ESPERA_S = Number(process.argv[3] || 120);
const PORTAS = [443, 5432, 80, 8080, 8443, 2098, 33306];
const LOG = 'descobre_porta.log';

const log = (m) => { const l = `[${new Date().toISOString()}] ${m}\n`; fs.appendFileSync(LOG, l); process.stdout.write(l); };

const FILA = [
  ['/get_about.fcgi', {}, false],
  ['/login.fcgi', { login: 'admin', password: 'admin' }, false],
  ['/get_system_information.fcgi', {}, false],
  ['/get_afd.fcgi', { limit: 5, offset: 0 }, true],
  ['/load_users.fcgi', { limit: 3, offset: 0 }, true],
];

let respostas = 0;
const portasVivas = new Set();

function req(caminho, corpo) {
  const b = Buffer.from(JSON.stringify(corpo), 'utf-8');
  return Buffer.concat([
    Buffer.from(`POST ${caminho} HTTP/1.1\r\nHost: idcloud\r\nUser-Agent: iZCloud/1.0\r\nAccept: */*\r\nContent-Type: application/json\r\nContent-Length: ${b.length}\r\nConnection: keep-alive\r\n\r\n`, 'latin1'), b]);
}

for (const porta of PORTAS) {
  const s = tls.createServer({
    key: fs.readFileSync('chave.pem'), cert: fs.readFileSync('cert.pem'),
    minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
  }, (sock) => {
    log('');
    log(`================ CONEXAO NA PORTA ${porta} ================`);
    log(`  ${sock.getProtocol()}  ${sock.getCipher().name}`);
    let buf = '';
    let sessao = null;
    let ultimo = '';
    let i = 0;
    const proximo = () => {
      if (i >= FILA.length) { setTimeout(() => sock.end(), 500); return; }
      const [caminho, corpo, usarSessao] = FILA[i++];
      const dados = usarSessao && sessao ? { ...corpo, session: sessao } : corpo;
      ultimo = caminho;
      try { sock.write(req(caminho, dados)); log(`  >>> ${caminho} ${JSON.stringify(dados)}`); }
      catch (e) { log('  >>> falhou: ' + e.message); }
    };
    sock.on('data', (d) => {
      buf += d.toString('utf-8');
      while (true) {
        const f = buf.indexOf('\r\n\r\n');
        if (f < 0) break;
        const cab = buf.slice(0, f);
        const m = /content-length:\s*(\d+)/i.exec(cab);
        const total = Number(m ? m[1] : 0);
        const corpo = buf.slice(f + 4, f + 4 + total);
        if (corpo.length < total) break;
        respostas++;
        const j = /\{/.exec(corpo);
        log(`  <<< ${cab.split('\r\n')[0]}  ${(j ? corpo.slice(j.index) : corpo).slice(0, 300).replace(/\n/g, ' | ')}`);
        if (/login\.fcgi/.test(ultimo)) { try { sessao = JSON.parse(corpo).session; log(`      >>> sessao: ${sessao}`); } catch {} }
        buf = buf.slice(f + 4 + total);
        proximo();
      }
    });
    sock.on('close', () => log('  REP fechou a conexao'));
    sock.on('error', (e) => log('  erro: ' + e.message));
    setTimeout(proximo, 500);
  });
  s.on('tlsClientError', (e) => log(`  [${porta}] erro de TLS: ${e.message}`));
  s.on('error', (e) => { if (e.code === 'EADDRINUSE') log(`  [${porta}] ja em uso`); else log(`  [${porta}] ${e.code}`); });
  s.listen(porta, MEU, () => { portasVivas.add(porta); log(`escutando ${MEU}:${porta}`); });
}

function f(comando, dados = {}) {
  return new Promise((ok, no) => {
    const corpo = JSON.stringify(dados);
    const i = comando.indexOf('?');
    const path = i >= 0 ? `/${comando.slice(0, i)}.fcgi${comando.slice(i)}` : `/${comando}.fcgi`;
    const r = https.request({ hostname: REP, port: REP_PORTA, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
      rejectUnauthorized: false, insecureHTTPParser: true, timeout: 15000 },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => ok(b)); });
    r.on('error', no);
    r.on('timeout', () => { r.destroy(); no(new Error('timeout')); });
    r.write(corpo); r.end();
  });
}

const s = JSON.parse(await f('login', { login: 'admin', password: 'admin' })).session;
log(`interval -> ${INTERVALO}`);
await f(`set_idcloud?session=${s}`, { enable: true, interval: INTERVALO });
const t0 = Date.now();
while (Date.now() - t0 < ESPERA_S * 1000 && respostas < 5) {
  await new Promise((r) => setTimeout(r, 2000));
  process.stdout.write('.');
}
log('');
log(`portas que receberam: ${[...portasVivas].join(', ')}`);
log(`respostas FCGI recebidas: ${respostas}`);
log('restaurando interval=2078000');
log(await f(`set_idcloud?session=${s}`, { enable: true, interval: 2078000 }));
process.exit(respostas >= 5 ? 0 : 1);
