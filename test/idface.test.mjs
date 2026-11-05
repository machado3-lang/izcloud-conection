// Testes das funcoes puras do coletor iDFace (sem banco e sem equipamento).
// As linhas reais vieram do iDFace 6.26.4 e do AFD 671 do RHiD (05/11/2026).
import assert from 'node:assert/strict';
import {
  parseAfdIdface, parseAccessLogs, parseUsuarios, montarComando, processarResultado,
} from '../idface.js';

const afd595 = [
  '0000000001100000000000000000000000000ControliD',
  '00000000130511202610200701756811724A72',
  '00000000230511202610270701756811724D72',
  '00000000530511202611590026134494240FB6',
  '9999999990000000000000000060000000000000000000000000009',
].join('\r\n');

const afd671 = [
  '00000000132026-11-05T10:20:00-0400070175681172ADB4',
  '00000000532026-11-05T11:59:00-0400002613449424D5FC',
].join('\r\n');

const afdRhId671Tipo7 = [
  '00000005172026-11-05T11:59:00-04000193736130652026-11-05T12:59:00-030004069bc375f5e4e71ed3b1fbb4c0f51651a21e4b96197d5f8430086c1eebd295d12',
].join('\r\n');

console.log('1) AFD 595: documento = users.id, ignora header/trailer');
{
  const m = parseAfdIdface(afd595);
  assert.equal(m.length, 3);
  assert.equal(m[0].documento, '70175681172');
  assert.equal(m[0].tipoRegistro, '3');
  assert.equal(m[0].dataHora.getFullYear(), 2026);
  assert.equal(m[0].dataHora.getHours(), 10);
  assert.equal(m[2].documento, '02613449424');
  assert.ok(afd595.includes('999999999'));
}

console.log('2) AFD 671: documento com zero a esquerda e fuso');
{
  const m = parseAfdIdface(afd671);
  assert.equal(m.length, 2);
  assert.equal(m[0].documento, '70175681172');
  assert.equal(m[1].documento, '02613449424');
  assert.equal(m[1].fuso, '-0400');
  assert.equal(m[1].dataHora.getUTCHours(), 15); // 11:59 -0400 = 15:59 UTC
}

console.log('3) AFD 671 tipo 7 (REP-P): CPF + hash + fuso da marcacao');
{
  const m = parseAfdIdface(afdRhId671Tipo7);
  assert.equal(m.length, 1);
  assert.equal(m[0].tipoRegistro, '7');
  assert.equal(m[0].documento, '19373613065');
  assert.equal(m[0].fuso, '-0400');
  assert.equal(m[0].sha256.length, 64);
}

console.log('4) access_logs: epoch -> Date e user_id -> deviceUserId');
{
  const m = parseAccessLogs({
    access_logs: [
      { id: 1, time: 1793874026, user_id: 70175681172, event: 7 },
      { id: 2, time: 1793874471, user_id: 0, event: 3 },
    ],
  });
  assert.equal(m.length, 2);
  assert.equal(m[0].deviceUserId, 70175681172);
  assert.equal(m[0].origem, 'access_logs');
  assert.ok(m[0].dataHora instanceof Date);
  assert.ok(m[0].dataHora.getTime() > 0);
}

console.log('5) users + c_users: CPF vem da tabela customizada');
{
  const u = parseUsuarios(
    { users: [{ id: 70175681172, registration: '02613449424', name: 'ANTONIO TESTE' }] },
    { c_users: [{ user_id: 70175681172, cpf: '19373613065' }] }
  );
  assert.equal(u.length, 1);
  assert.equal(u[0].registration, '02613449424');
  assert.equal(u[0].cpf, '19373613065');
  assert.equal(u[0].nome, 'ANTONIO TESTE');
}

console.log('6) comando: mode=671 vai em queryString, nunca no endpoint');
{
  const cmd = montarComando({
    verb: 'POST', endpoint: 'export_afd', body: '{}',
    query_string: 'mode=671', content_type: 'application/json',
  });
  assert.equal(cmd.endpoint, 'export_afd');
  assert.equal(cmd.queryString, 'mode=671');
  assert.deepEqual(cmd.body, {});
}

console.log('7) /result de export_afd: grava marcacoes e salva o arquivo bruto');
{
  const chamadas = [];
  const pool = {
    query: async (sql, params) => { chamadas.push({ sql, params }); return [{ insertId: 1 }]; },
  };
  let salvo = null;
  const resumo = await processarResultado(pool, {
    schema: 'tenant_0001',
    dispositivo: { id: 9, portaria: '671', serial: '0M0200/02506F' },
    comando: { endpoint: 'export_afd', body: '{}', query_string: 'mode=671' },
    endpoint: 'export_afd',
    response: afd671,
    salvarArquivo: async (dados) => { salvo = dados; return { id: 1 }; },
  });
  assert.equal(resumo.marcacoes, 2);
  assert.equal(resumo.arquivo.id, 1);
  assert.ok(salvo.texto.includes('0000000013'));
  assert.equal(salvo.formato, '671');
  assert.ok(chamadas.some((c) => /INSERT INTO idface_marcacoes/.test(c.sql)));
}

console.log('8) /result de load_objects access_logs e users+c_users');
{
  const pool = { query: async () => [{ insertId: 1 }] };
  const logs = await processarResultado(pool, {
    schema: 'tenant_0001',
    dispositivo: { id: 9, portaria: '671' },
    comando: { endpoint: 'load_objects', body: '{"object":"access_logs"}' },
    endpoint: 'load_objects',
    response: { access_logs: [{ id: 1, time: 1793874026, user_id: 70175681172 }] },
  });
  assert.equal(logs.marcacoes, 1);

  const users = await processarResultado(pool, {
    schema: 'tenant_0001',
    dispositivo: { id: 9, portaria: '671' },
    comando: { endpoint: 'load_objects', body: '{"object":"users"}' },
    endpoint: 'load_objects',
    response: { users: [{ id: 70175681172, registration: '02613449424', name: 'ANTONIO' }] },
  });
  assert.equal(users.usuarios, 1);
}

console.log('\nRESULTADO: TODOS OS TESTES DO IDFACE PASSARAM');
