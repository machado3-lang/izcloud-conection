// Capturador de tentativa de conexao do REP.
//
// O REP tem o iDCloud ligado (get_idcloud -> enable:true, interval:2078000) e
// o IP 69.46.46.112 gravado na config. A porta NAO esta na config (o campo
// depois do IP e' o interval), entao a porta e' hardcoded no firmware e so da
// para descobrir observando.
//
// Uso:  node captura_rep.mjs [ip_local]          (default 192.168.100.179)
// Fica escutando varias portas e grava em captura_rep.log o que chegar.
// Para quando o arquivo captura_rep.flag existir.
import net from 'net';
import fs from 'fs';

const MEU_IP = process.argv[2] || '192.168.100.179';
const LOG = 'captura_rep.log';
const FLAG = 'captura_rep.flag';

// portas candidatas: as de servico web, as de MySQL e as vizinhas
const PORTAS = [80, 443, 3306, 3307, 33060, 8080, 8443, 4443, 7443, 9443,
  2098, 2099, 33306, 3389, 8081, 8888, 9090, 5000, 5001, 4000, 8082, 8083,
  8444, 10000, 18080, 28080, 8181, 8282, 9001, 9200, 5555, 6666, 7777, 3000, 3001];

const log = (m) => { const l = `[${new Date().toISOString()}] ${m}\n`; fs.appendFileSync(LOG, l); process.stdout.write(l); };

function classificar(buf) {
  if (!buf.length) return 'conexao aberta e fechada sem dados';
  const b = buf;
  if (b[0] === 0x16 && b[1] === 0x03) return '*** TLS/HTTPS (ClientHello) ***';
  if (/^(GET|POST|PUT|HEAD|HTTP)/.test(buf.toString('latin1', 0, 8))) return '*** HTTP ***';
  if (b[0] === 0x04 && b[1] === 0x00 && b[2] === 0x00) return 'MySQL (packet 4 = ServerHello)';
  if (b[4] === 0x0a && /[\x20-\x7e]{6,}/.test(buf.toString('latin1', 5, 60))) return 'MySQL (string de protocolo: ' + buf.toString('latin1', 5, 40).replace(/\0/g, '') + ')';
  const t = buf.toString('latin1', 0, 40).replace(/[^\x20-\x7e]/g, '.');
  return 'desconhecido: ' + t;
}

log(`=== captura iniciada em ${MEU_IP} ===`);
log(`portas: ${PORTAS.join(', ')}`);

const sockets = [];
PORTAS.forEach((porta) => {
  const s = net.createServer((sock) => {
    const origem = `${sock.remoteAddress}:${sock.remotePort}`;
    log('');
    log(`>>> CONEXAO RECEBIDA na porta ${porta} de ${origem}`);
    const pedacos = [];
    sock.on('data', (d) => { pedacos.push(d); log(`  <- ${d.length} bytes de ${origem}`); });
    sock.on('end', () => log(`  <- ${origem} fechou o envio`));
    sock.on('close', () => {
      const todo = Buffer.concat(pedacos);
      // Grava os bytes crus: parsear hexdump de log e' fragil (prefixo de
      // timestamp, truncamento em 256 B) e o ClientHello inteiro e' o que
      // interessa. O .bin e' a fonte da verdade.
      const arq = `captura_${new Date().toISOString().replace(/[:.]/g, '-')}_p${porta}.bin`;
      try { fs.writeFileSync(arq, todo); } catch (e) { log(`  nao consegui gravar ${arq}: ${e.message}`); }
      log(`<-- RESUMO porta ${porta} / ${origem}: ${todo.length} bytes (salvo em ${arq})`);
      log(`<-- TIPO: ${classificar(todo)}`);
      log('<-- HEX (primeiros 256 B):');
      for (let i = 0; i < Math.min(todo.length, 256); i += 16) {
        const f = todo.subarray(i, i + 16);
        log('    ' + i.toString(16).padStart(4, '0') + '  ' +
          [...f].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47) + '  |' +
          [...f].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('') + '|');
      }
      log('');
    });
    sock.on('error', () => {});
  });
  s.on('error', (e) => { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') log(`porta ${porta}: ${e.code}`); });
  s.listen(porta, MEU_IP, () => log(`escutando ${MEU_IP}:${porta}`));
  sockets.push(s);
});

const parar = setInterval(() => { if (fs.existsSync(FLAG)) { log('flag encontrada, encerrando'); clearInterval(parar); sockets.forEach((s) => s.close()); process.exit(0); } }, 1000);
log('para o capturador: crie o arquivo ' + FLAG);
