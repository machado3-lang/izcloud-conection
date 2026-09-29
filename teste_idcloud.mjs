// Teste ponta a ponta do servico iDCloud contra o REP real, SEM MySQL: o REP
// abre a conexao, o servico trava pela serie, loga e le AFD, usuarios e
// empresa. E o que fecha a investigacao do protocolo.
//   node teste_idcloud.mjs
import fs from 'fs';
import https from 'https';
import { criarServidor, reservarVaga, baixarAfd, lerFuncionarios, lerEmpresa } from './idcloudServer.js';

const REP = '192.168.100.132';
// O servidor web do REP foi movido para 5432; o canal iDCloud continua na 443.
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
    r.on('timeout', () => { r.destroy(); no(new Error('timeout')); });
    r.write(corpo); r.end();
  });
}

const ok = (m) => console.log('  ok  ' + m);
let resultado = null;
const feito = new Promise((r) => { globalThis.__feito = r; });

reservarVaga(1, 10);
const srv = await criarServidor({
  cert: fs.readFileSync('cert.pem'),
  key: fs.readFileSync('chave.pem'),
  porta: 443,
  host: '192.168.100.179',
  aoConectar: async (ctx) => {
    console.log(`\n[atendimento] REP ${ctx.rep.nSerie} -> id_reps=${ctx.id_reps}`);
    ok('a trava de serie deixou passar o REP esperado');

    const usuarios = await lerFuncionarios(ctx, { limite: 5, offset: 0 });
    ok(`${usuarios.length} funcionarios lidos; primeiro: ${usuarios[0]?.name} (pis=${usuarios[0]?.pis})`);

    const curtos = usuarios.filter((u) => [u.pis, u.cpf].some((v) => v != null && String(v).length <= 6));
    console.log(`      numeros curtos (1-6 digitos) nesta pagina: ${curtos.length}` +
      (curtos.length ? ' -> ' + curtos.map((u) => `${u.name}=${u.pis || u.cpf}`).join(', ') : ''));

    const empresa = await lerEmpresa(ctx);
    ok('empresa: ' + (empresa ? JSON.stringify(empresa).slice(0, 120) : '(vazia)'));

    const afd = await baixarAfd(ctx, { limite: 10, offset: 0 });
    ok(`AFD: ${afd.batidas} batidas, ${afd.texto.length} bytes, ultimo NSR ${afd.ultimoNsr}`);
    console.log('      primeiras linhas do AFD:');
    for (const l of afd.texto.split(/\r?\n/).slice(0, 4)) console.log('        ' + l);

    resultado = { serie: ctx.rep.nSerie, usuarios: usuarios.length, empresa: !!empresa, batidas: afd.batidas };
    globalThis.__feito(resultado);
  },
});

const sess = JSON.parse(await fcgi('login', { login: 'admin', password: 'admin' })).session;
await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: 8 });
console.log('interval -> 8; esperando o REP conectar (ate 100s)...');

const t0 = Date.now();
while (Date.now() - t0 < 100000 && !resultado) await new Promise((r) => setTimeout(r, 1500));
await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: 2078000 });
console.log('\ninterval restaurado para 2078000');
srv.close();

if (!resultado) { console.log('\nRESULTADO: FALHOU (nenhuma conexao atendida)'); process.exit(1); }
console.log('\nRESULTADO: TODOS OS TESTES PASSARAM');
console.log(JSON.stringify(resultado));
process.exit(0);
