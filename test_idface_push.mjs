// test_idface_push.mjs — captura o push do iDFace e testa o formato oficial.
//
//   node test_idface_push.mjs
//   PUSH_PORT=8088 PUSH_CMD=message node test_idface_push.mjs
//   PUSH_TLS=1 PUSH_PORT=8443 node test_idface_push.mjs
//
// Configure no iDFace o push_remote_address apontando para
//   http://<IP-DESTA-MAQUINA>:8088
// (o equipamento chama /push, /result, ...). O script imprime as interfaces
// de rede para facilitar.
//
// PUSH_CMD:
//   message  -> enfileira message_to_screen (teste inofensivo)
//   info     -> enfileira get_system_info
//   none     -> so responde { "transactions": [] } (padrao)
//
// O capturador grava cada requisicao em idface_push_capture.log (uma linha JSON).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';

const PORT = Number(process.env.PUSH_PORT || 8088);
const LOG = process.env.PUSH_LOG || 'idface_push_capture.log';
const TLS = /^(1|true|sim)$/i.test(String(process.env.PUSH_TLS || 'false'));
const CMD = String(process.env.PUSH_CMD || 'none').toLowerCase();

const fila = [];
if (CMD === 'message') {
  fila.push({
    verb: 'POST',
    endpoint: 'message_to_screen',
    body: { message: 'Teste iZCloud', timeout: 5000 },
    contentType: 'application/json',
  });
}
if (CMD === 'info') {
  fila.push({
    verb: 'POST',
    endpoint: 'get_system_info',
    body: {},
    contentType: 'application/json',
  });
}
if (CMD === 'export_afd' || CMD === 'export_afd_671') {
  fila.push({
    verb: 'POST',
    endpoint: 'export_afd',
    body: {},
    ...(CMD === 'export_afd_671' ? { queryString: 'mode=671' } : {}),
    contentType: 'application/json',
  });
}
if (CMD === 'access_logs') {
  fila.push({
    verb: 'POST',
    endpoint: 'load_objects',
    body: { object: 'access_logs', limit: 10, offset: 0 },
    contentType: 'application/json',
  });
}
if (CMD === 'users') {
  fila.push({
    verb: 'POST',
    endpoint: 'load_objects',
    body: { object: 'users', limit: 100, offset: 0 },
    contentType: 'application/json',
  });
}

function ips() {
  const out = [];
  for (const [nome, lista] of Object.entries(os.networkInterfaces())) {
    for (const i of lista || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(`${nome}: ${i.address}`);
    }
  }
  return out;
}

function gravar(registro) {
  try { fs.appendFileSync(LOG, JSON.stringify(registro) + '\n'); } catch {}
}

function responder(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function handler(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url || '/';
    const path = url.split('?')[0];
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch {}

    const registro = {
      recebido: new Date().toISOString(),
      metodo: req.method,
      url,
      path,
      query: Object.fromEntries(new URL(url, 'http://x').searchParams),
      headers: req.headers,
      corpo: json ?? body.slice(0, 4000),
    };
    gravar(registro);
    console.log(`\n[${registro.recebido}] ${req.method} ${url}`);
    console.log('  headers:', JSON.stringify(req.headers));
    if (Object.keys(registro.query).length) console.log('  query:', JSON.stringify(registro.query));
    if (body) console.log('  body:', (json ? JSON.stringify(json) : body).slice(0, 5000));

    // O iDFace chama /push para buscar comando e /result para devolver o
    // resultado. Tambem aceitamos /event e /api/notifications/* (Monitor).
    if (path === '/push' || path.endsWith('/push') || path.endsWith('/push/poll') || path.endsWith('/poll')) {
      if (fila.length) {
        const cmd = fila.shift();
        console.log('  -> enviando comando:', JSON.stringify(cmd));
        return responder(res, 200, cmd);
      }
      return responder(res, 200, { transactions: [] });
    }
    if (path === '/result' || path.endsWith('/result') || path.endsWith('/push/result')) {
      console.log('  -> resultado recebido');
      return responder(res, 200, {});
    }
    if (path === '/event' || path.endsWith('/event') || path.includes('/notifications/')) {
      return responder(res, 200, {});
    }
    return responder(res, 200, {});
  });
}

const server = TLS
  ? https.createServer({ cert: fs.readFileSync('cert.pem'), key: fs.readFileSync('chave.pem') }, handler)
  : http.createServer(handler);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nCapturador iDFace ouvindo em ${TLS ? 'https' : 'http'}://0.0.0.0:${PORT}`);
  console.log('Interfaces desta maquina:');
  for (const i of ips()) console.log('  ' + i);
  console.log(`\nNo iDFace, configure push_remote_address = ${TLS ? 'https' : 'http'}://<IP-ACIMA>:${PORT}`);
  console.log(`Comando inicial: ${CMD}${fila.length ? ` (${fila.length} na fila)` : ''}`);
  console.log(`Log: ${LOG}\n`);
});
