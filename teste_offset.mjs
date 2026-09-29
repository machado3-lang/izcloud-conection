// Descobre se existe alguma forma de paginar o AFD. No aparelho, get_afd
// devolve sempre as MESMAS primeiras N linhas, com limite maximo de 1000, e o
// 'offset' e' aceito mas ignorado. Se nenhuma variante funcionar, a coleta
// completa depende de a Maquina rotacionar o arquivo.
//   node teste_offset.mjs
import fs from 'fs';
import https from 'https';
import { criarServidor, reservarVaga } from './idcloudServer.js';

const REP = '192.168.100.132';
const PORTA_FCGI = Number(process.env.REP_PORTA || 5432);

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
    r.on('timeout', () => { r.destroy(); no(new Error('t')); });
    r.write(corpo); r.end();
  });
}

const VARIANTES = [
  ['mode=671', { mode: '671' }],
  ['mode=1510', { mode: '1510' }],
  ['coletor=1', { coletor: 1 }],
  ['idEquipamento=0', { idEquipamento: 0 }],
  ['nsrInicial=1000', { nsrInicial: 1000 }],
  ['offset=5000', { offset: 5000 }],
  ['dataInicio', { dataInicio: '2018-01-01' }],
  ['format=0', { format: 0 }],
  ['todos=1', { todos: 1 }],
  ['download=1', { download: 1 }],
];

let pronto = null;
reservarVaga(1, 10);
const srv = await criarServidor({
  cert: fs.readFileSync('cert.pem'), key: fs.readFileSync('chave.pem'),
  porta: 443, host: '192.168.100.179',
  aoConectar: async (ctx) => {
    const out = {};
    // referencia: sem nenhum parametro alem de limit
    const base = await ctx.rep.pedir('get_afd', { session: ctx.rep.session, limit: 5 }, { binario: true });
    const ref = (base.binario || '').trim().split(/\r?\n/)[0] || '';
    out['(referencia)'] = ref.slice(0, 50);
    for (const [nome, extra] of VARIANTES) {
      try {
        const r = await ctx.rep.pedir('get_afd', { session: ctx.rep.session, limit: 5, ...extra }, { binario: true });
        const t = (r.binario || '').trim().split(/\r?\n/)[0] || '';
        out[nome] = (t === ref ? '= igual   ' : '!= DIFERE ') + t.slice(0, 44);
      } catch (e) { out[nome] = 'ERRO: ' + e.message; }
    }
    pronto = out;
  },
});

const sess = JSON.parse(await fcgi('login', { login: 'admin', password: 'admin' })).session;
await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: 8 });
const t0 = Date.now();
while (Date.now() - t0 < 90000 && !pronto) await new Promise((r) => setTimeout(r, 1500));
await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: 2078000 });
srv.close();
if (!pronto) { console.log('sem resposta'); process.exit(1); }

console.log('\nprimeira linha devolvida por variante (limit=5):\n');
for (const [k, v] of Object.entries(pronto)) console.log('  ' + k.padEnd(16) + v);
const algumDiferente = Object.entries(pronto).some(([k, v]) => k !== '(referencia)' && !v.startsWith('='));
console.log('\nRESULTADO: ' + (algumDiferente
  ? 'algum parametro muda a janela -> vale investigar o que ele faz'
  : 'NENHUM parametro pagina o AFD: o REP sempre devolve as primeiras N linhas'));
process.exit(0);
