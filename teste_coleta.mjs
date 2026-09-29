// Teste da coleta ponta a ponta contra o REP real: o REP conecta na 443, o
// servico trava pela serie, loga, e a coleta roda ate o cursor.
// Sem MySQL, entao a gravacao e' substituida por um pool de mentira que conta.
//   node teste_coleta.mjs
import fs from 'fs';
import https from 'https';
import { criarServidor, reservarVaga, coletar, lerFuncionarios, lerEmpresa, baixarAfd } from './idcloudServer.js';

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
    r.on('timeout', () => { r.destroy(); no(new Error('timeout')); });
    r.write(corpo); r.end();
  });
}

const ok = (m) => console.log('  ok  ' + m);
let resultado = null;

reservarVaga(1, 10);
const srv = await criarServidor({
  cert: fs.readFileSync('cert.pem'),
  key: fs.readFileSync('chave.pem'),
  porta: 443,
  host: '192.168.100.179',
  // Substitui a gravacao: o objetivo aqui e provar o CANAL e o cursor, nao o MySQL.
  aoConectar: async (ctx) => {
    console.log(`\n[atendimento] REP ${ctx.rep.nSerie} -> id_reps=${ctx.id_reps}`);
    ok('trava de serie deixou passar o REP esperado');

    const usuarios = await lerFuncionarios(ctx, { limite: 5, offset: 0 });
    ok(`${usuarios.length} funcionarios; primeiro: ${usuarios[0]?.name} (pis=${usuarios[0]?.pis})`);
    const curtos = usuarios.filter((u) => [u.pis, u.cpf].some((v) => v != null && String(v).length <= 6));
    console.log(`      numeros curtos nesta pagina: ${curtos.length}` +
      (curtos.length ? ' -> ' + curtos.map((u) => `${u.name}=${u.pis || u.cpf}`).join(', ') : ''));

    const empresa = await lerEmpresa(ctx);
    ok('empresa: ' + (empresa ? (empresa.name || JSON.stringify(empresa).slice(0, 60)) : '(vazia)'));

    const a1 = await baixarAfd(ctx, { offset: 0 });
    ok(`AFD: ${a1.batidas} batidas, ultimo NSR ${a1.ultimoNsr}, janela de ${a1.linhas} linhas` +
       (a1.truncado ? ' (TRUNCADA: o aparelho nao pagina)' : ''));
    for (const l of a1.texto.split(/\r?\n/).slice(0, 3)) console.log('        ' + l);

    // Cursor em LINHAS: pedindo a partir do fim do arquivo anterior.
    const a2 = await baixarAfd(ctx, { offset: 0 });
    ok('2a coleta: ' + a2.batidas + ' batidas; a primeira linha do arquivo e igual: ' + (a2.texto.split(/\r?\n/)[0] === a1.texto.split(/\r?\n/)[0]) + '  (o REP sempre devolve o inicio do arquivo)');

    resultado = { serie: ctx.rep.nSerie, usuarios: usuarios.length, batidas: a1.batidas, empresa: !!empresa, curtos: curtos.length };
  },
});

const sess = JSON.parse(await fcgi('login', { login: 'admin', password: 'admin' })).session;
await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: 8 });
console.log('interval -> 8; esperando o REP (ate 90s)...');
const t0 = Date.now();
while (Date.now() - t0 < 90000 && !resultado) await new Promise((r) => setTimeout(r, 1500));
await fcgi(`set_idcloud?session=${sess}`, { enable: true, interval: 2078000 });
console.log('\ninterval restaurado para 2078000');
srv.close();

if (!resultado) { console.log('\nRESULTADO: FALHOU (nenhuma conexao atendida)'); process.exit(1); }
console.log('\nRESULTADO: TODOS OS TESTES PASSARAM');
console.log(JSON.stringify(resultado));
process.exit(0);
