// Servidor HTTPS local que responde o handshake TLS e registra o que o REP
// manda depois. E o passo seguinte depois de descobrir a porta (443) e o
// transporte (TLS): agora queremos o caminho da URL e o corpo.
//
//   node https_rep.mjs [intervalo] [segundos]
//
// Certificado autoassado (cert.pem). Se o firmware validar a CA da Control iD,
// ele vai recusar e a gente ve o alert TLS — que tambem e' resposta.
import https from 'https';
import fs from 'fs';

const IP = '192.168.100.179';
const PORTA = 443;
const REP = '192.168.100.132';
const LOG = 'https_rep.log';
const INTERVALO = Number(process.argv[2] || 15);
const ESPERA_S = Number(process.argv[3] || 90);

const log = (m) => {
  const l = `[${new Date().toISOString()}] ${m}\n`;
  fs.appendFileSync(LOG, l);
  process.stdout.write(l);
};

const CA_CONTROL_ID = 'C:\\Producao\\Gerenciador REPs\\ControliD-CA.cer';

// O REP falou TLS 1.2 puro (sem supported_versions, logo sem TLS 1.3) e NAO
// mandou SNI nem ALPN — ele conecta por IP. Por isso o TLS 1.2 fica travado
// aqui: o OpenSSL 3.5 ofereceria 1.3 primeiro, e o mbedTLS de 2019 nao fala.
//
// `requestCert` responde a pergunta que a doc oficial ja sugeria (o
// CodeSigning2017.pfx): o REP manda certificado de cliente? Se mandar, o
// iDCloud e' mutual TLS e precisamos saber com que identidade ele se apresenta.
const servidor = https.createServer({
  key: fs.readFileSync('chave.pem'),
  cert: fs.readFileSync('cert.pem'),
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  requestCert: true,
  rejectUnauthorized: false,          // nao rejeita: so quero REGISTRAR o que veio
  ca: fs.existsSync(CA_CONTROL_ID) ? [fs.readFileSync(CA_CONTROL_ID)] : undefined,
}, (req, res) => {
    const pedacos = [];
    req.on('data', (d) => pedacos.push(d));
    req.on('end', () => {
      const corpo = Buffer.concat(pedacos);
      log('');
      log('*** REQUISICAO HTTP RECEBIDA ***');
      log(`  ${req.method} ${req.url} ${req.httpVersion}`);
      for (const [k, v] of Object.entries(req.headers)) log(`  ${k}: ${v}`);
      log(`  corpo: ${corpo.length} bytes`);
      if (corpo.length) {
        log('  --- corpo em texto ---');
        log(corpo.subarray(0, 4000).toString('utf-8'));
        log('  --- corpo em hex (primeiros 256 B) ---');
        for (let i = 0; i < Math.min(corpo.length, 256); i += 16) {
          const f = corpo.subarray(i, i + 16);
          log('    ' + [...f].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47) + '  |' +
            [...f].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('') + '|');
        }
        const arq = `rep_http_${Date.now()}.bin`;
        try { fs.writeFileSync(arq, corpo); log(`  corpo salvo em ${arq}`); } catch {}
      }
      // Resposta JSON vazia: o formato que o push oficial usa para "nada a fazer".
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transactions: [] }));
      log('  -> respondido 200 {"transactions":[]}');
    });
  });

// secureConnection dispara no fim do handshake, antes de qualquer HTTP. E' o
// ponto exato de "o REP aceitou nosso certificado?" — que e' a duvida principal
// depois que ele disse "conectado" uma vez e "falha" na outra.
//
// Depois do handshake o REP fica CALADO. Entao aqui o servidor fala primeiro:
// mando respostas/JSON plausiveis e qualquer coisa que ele devolva e' a chave
// do protocolo. Guardo o socket porque preciso escrever fora do handler.
const PROBES = [
  'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
  '{"transactions":[]}',
  '{"result":true}',
  '{"status":"ok"}',
  '{"session":""}',
  'CID-REP_iDClass:',
];

servidor.on('secureConnection', (s) => {
  const cert = s.getPeerCertificate();
  log('');
  log('*** HANDSHAKE TLS CONCLUIDO ***');
  log(`  versao ....: ${s.getProtocol()}`);
  log(`  cipher ....: ${s.getCipher().name}`);
  log(`  certificado do cliente: ${cert && cert.subject ? JSON.stringify(cert.subject) : '(NAO MANDOU)'}`);
  log(`  SNI (servername): ${s.servername || '(ausente)'}`);

  s.setTimeout(20000, () => log('  (socket ocioso por 20s, sem resposta do REP)'));

  // qualquer coisa que o REP mandar depois do handshake entra no log
  s.on('data', (d) => {
    log(`  <<< REP mandou ${d.length} bytes depois do handshake:`);
    log('      ' + d.subarray(0, 400).toString('utf-8').replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
    log('      hex: ' + d.subarray(0, 120).toString('hex'));
  });

  // servidor fala primeiro, um por vez, com um respiro entre eles
  PROBES.forEach((p, i) => {
    setTimeout(() => {
      try {
        s.write(p);
        log(`  >>> servidor mandou [${i}] ${p.length} B: ${JSON.stringify(p.slice(0, 70))}`);
      } catch (e) { log(`  >>> probe ${i} falhou: ${e.message}`); }
    }, 800 + i * 2500);
  });
});

servidor.on('tlsClientError', (e) => log(`!!! erro de TLS: ${e.message} (codigo ${e.code || '?'})`));
servidor.on('clientError', (e) => log(`!!! erro de socket: ${e.message} (${e.code || '?'})`));
servidor.listen(PORTA, IP, () => log(`HTTPS em https://${IP}:${PORTA} (certificado autoassado)`));

function fcgi(comando, dados = {}) {
  return new Promise((resolve, reject) => {
    const corpo = JSON.stringify(dados);
    const i = comando.indexOf('?');
    const path = i >= 0 ? `/${comando.slice(0, i)}.fcgi${comando.slice(i)}` : `/${comando}.fcgi`;
    const req = https.request({ hostname: REP, port: 443, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
      rejectUnauthorized: false, insecureHTTPParser: true, timeout: 15000 },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(corpo); req.end();
  });
}

const sess = JSON.parse(await fcgi('login', { login: 'admin', password: 'admin' })).session;
log(`interval -> ${INTERVALO}`);
await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: INTERVALO });
log('estado: ' + (await fcgi(`get_idcloud?session=${sess}`)));

const t0 = Date.now();
while (Date.now() - t0 < ESPERA_S * 1000) {
  await new Promise((r) => setTimeout(r, 2000));
  const t = fs.readFileSync(LOG, 'utf-8');
  if (/REQUISICAO HTTP RECEBIDA/.test(t)) break;
  process.stdout.write('.');
}
log('');
log('restaurando interval=2078000');
log(await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: 2078000 }));
log('estado: ' + (await fcgi(`get_idcloud?session=${sess}`)));
servidor.close();
process.exit(0);
