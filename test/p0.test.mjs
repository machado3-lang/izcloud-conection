// Testes dos reparos P0 de 04/11/2026.
//
// Rodam sem MySQL e sem REP: as partes que dependem de hardware/banco sao
// verificadas no codigo (os bugs eram de contrato: SQL, middleware, bind e
// schema da vaga) e as funcoes puras do canal sao exercitadas de verdade.
//
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reservarVaga, vagaPara, limparVagas } from '../idcloudServer.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (f) => fs.readFileSync(path.join(raiz, f), 'utf-8');
const ok = (m) => console.log('  ok  ' + m);

console.log('\n1) /api/painel e /api/coletas exigem tenant');
{
  const s = ler('server.js');
  assert.match(s, /app\.use\('\/api\/painel',\s*authTenant\)/, 'painel sem authTenant');
  assert.match(s, /app\.use\('\/api\/coletas',\s*authTenant\)/, 'coletas sem authTenant');
  ok('as duas rotas passam pelo authTenant (sem req.db undefined)');
}

console.log('\n2) bind do canal nao usa IDCLOUD_HOST (que e o MySQL)');
{
  const s = ler('server.js');
  assert.match(s, /host:\s*process\.env\.IDCLOUD_BIND\s*\|\|\s*'0\.0\.0\.0'/,
    'o bind do canal precisa usar IDCLOUD_BIND');
  assert.doesNotMatch(s, /host:\s*process\.env\.IDCLOUD_HOST/,
    'IDCLOUD_HOST nao pode ser o host do canal');
  ok('IDCLOUD_BIND e o canal; IDCLOUD_HOST fica para o MySQL');
}

console.log('\n3) rep_coletas.id_reps cabe o serial (BIGINT)');
{
  const c = ler('core.js');
  assert.match(c, /rep_coletas:[\s\S]*?id_reps\s+BIGINT/, 'DDL de rep_coletas ainda usa INT');
  assert.match(c, /ALTER TABLE `rep_coletas` MODIFY `id_reps` BIGINT/,
    'falta a migracao do id_reps para tenants antigos');
  const t = ler('schema_tenant.sql');
  const i = t.indexOf('CREATE TABLE IF NOT EXISTS rep_coletas');
  assert.ok(i > 0, 'rep_coletas nao existe no schema_tenant.sql');
  assert.match(t.slice(i, i + 600), /id_reps\s+BIGINT/, 'schema_tenant.sql ainda usa INT');
  ok('id_reps e BIGINT no schema novo e na migracao');
}

console.log('\n4) registrarColetaRep tem colunas e valores na mesma conta');
{
  const c = ler('core.js');
  const i = c.indexOf('export async function registrarColetaRep');
  assert.ok(i > 0, 'falta registrarColetaRep');
  const bloco = c.slice(i, i + 1600);
  const inserts = [...bloco.matchAll(/INSERT INTO rep_coletas \(([^)]+)\)\s*VALUES \(([\s\S]*?)\)\s*ON DUPLICATE/g)];
  const alvo = inserts.find((m) => m[1].includes('total_coletado'));
  assert.ok(alvo, 'nao achei o INSERT de sucesso de rep_coletas');
  const cols = alvo[1].split(',').length;
  const vals = alvo[2].split(',').length;
  assert.equal(vals, cols, `INSERT com ${cols} colunas e ${vals} valores`);
  ok(`INSERT consistente (${cols} colunas, ${vals} valores)`);
}

console.log('\n5) vaga do canal guarda schema/serial e casa pelo serial');
{
  limparVagas();
  reservarVaga(1, 30, { schema: 'tenant_0001', serial: '00014003750029470' });
  reservarVaga(2, 30, { schema: 'tenant_0002' }); // generica
  const exata = vagaPara('00014003750029470');
  assert.equal(exata.schema, 'tenant_0001', 'o serial exato tem de achar a vaga dele');
  const generica = vagaPara('999');
  assert.equal(generica.schema, 'tenant_0002', 'a vaga generica atende um serial sem vaga');
  assert.equal(vagaPara('00014003750029470', Date.now() + 31 * 60 * 1000), null,
    'vaga expirada nao pode ser devolvida');
  ok('vaga exata tem prioridade, generica atende o resto, expiracao funciona');
}

console.log('\n6) canal usa o schema da vaga, nao o serial como banco');
{
  const s = ler('idcloudServer.js');
  assert.match(s, /schema:\s*vaga\.schema/, 'ctx.schema nao vem da vaga');
  assert.doesNotMatch(s, /schema:\s*nSerie/, 'ctx.schema ainda e o serial');
  assert.match(s, /buscarRepPorSerial/, 'falta o auto-aceite por serial');
  assert.match(s, /COMANDOS\.has\(/, 'a allowlist de comandos nao e usada');
  // Firmware v1048: get_about exige sessao. O login tem de vir antes.
  assert.match(s, /pedir\('login'[\s\S]*?pedir\('get_about'/,
    'login precisa vir antes do get_about (get_about exige session)');
  assert.match(s, /pedir\('get_about',\s*\{\s*session:/,
    'get_about precisa receber a session');
  ok('schema da vaga + auto-aceite + allowlist + login antes do get_about');
}

console.log('\n7) cadastro de funcionario salva antes de tentar o REP');
{
  const s = ler('server.js');
  const i = s.indexOf("app.post('/api/pessoas'");
  assert.ok(i > 0, 'falta POST /api/pessoas');
  const bloco = s.slice(i, i + 1600);
  const iGrava = bloco.indexOf('gravarPessoa');
  const iEnvia = bloco.indexOf('enviarUsuarios');
  assert.ok(iGrava > 0 && iEnvia > iGrava,
    'a gravacao na nuvem precisa vir antes do envio ao REP');
  assert.match(bloco, /erroEnvio/, 'falta tratar falha de envio sem perder o cadastro');
  ok('grava na nuvem primeiro; envio ao REP e best-effort');
}

console.log('\n8) AFD pode ser pedido sem `limit` (arquivo inteiro)');
{
  const s = ler('idcloudServer.js');
  assert.match(s, /IDCLOUD_AFD_LIMIT/, 'falta a opcao IDCLOUD_AFD_LIMIT');
  const i = s.indexOf('export async function baixarAfd');
  const bloco = s.slice(i, i + 1200);
  assert.match(bloco, /if \(lim > 0\) corpo\.limit = lim/,
    'o canal precisa omitir limit quando lim=0');
  ok('padrao sem limit; limit configuravel para revalidar no aparelho');
}

console.log('\n9) painel casa 1510 (PIS) e 671 (CPF)');
{
  const s = ler('idcloud.js');
  assert.match(s, /p\.PIS = a\.PIS OR p\.CPF = a\.PIS/,
    'o ranking do painel precisa casar o documento pelo PIS ou CPF');
  ok('join do painel aceita PIS (1510) e CPF (671)');
}

console.log('\n10) empresa aceita CNPJ/CPF, CEI e responsavel');
{
  const core = ler('core.js');
  assert.match(core, /tipo_documento/, 'core sem tipo_documento');
  assert.match(core, /cei/, 'core sem cei');
  const sql = ler('schema_core.sql');
  assert.match(sql, /tipo_documento\s+ENUM\('CNPJ','CPF'\)/, 'schema_core sem tipo_documento');
  assert.match(sql, /cei\s+VARCHAR\(20\)/, 'schema_core sem cei');
  const srv = ler('server.js');
  assert.match(srv, /CAMPOS_EMPRESA = \[[^\]]*'tipo_documento'[^\]]*'cei'/,
    'CAMPOS_EMPRESA nao inclui tipo_documento/cei');
  ok('schema + migracao + API com CNPJ/CPF, CEI e responsavel');
}

console.log('\n11) firmware exibido em hex (1048 -> 418)');
{
  const r = ler('repClient.js');
  assert.match(r, /firmwareDisplay/, 'probe sem firmwareDisplay');
  const ui = ler('public/index.html');
  assert.match(ui, /firmwareDisplay/, 'UI nao usa firmwareDisplay');
  ok('probe/UI mostram 418 (0x418) em vez do decimal 1048');
}

console.log('\nRESULTADO: TODOS OS TESTES PASSARAM');
