// Testes do parser HTTP do canal iDCloud: corpo com Content-Length e chunked.
// O REP manda o AFD grande em Transfer-Encoding: chunked; sem isso o canal
// lia "sem corpo" e gravava 0 batidas.
import assert from 'node:assert/strict';
import { decodificarChunked } from '../idcloudServer.js';

const ok = (m) => console.log('  ok  ' + m);

console.log('\n1) Chunked completo');
{
  const buf = Buffer.from('4\r\n0000\r\n3\r\n123\r\n0\r\n\r\n', 'latin1');
  const r = decodificarChunked(buf);
  assert.equal(r.completo, true);
  assert.equal(r.texto, '0000123');
  assert.equal(r.consumido, buf.length);
  ok('dois chunks + terminador');
}

console.log('\n2) Chunked incompleto');
{
  const r = decodificarChunked(Buffer.from('4\r\n00', 'latin1'));
  assert.equal(r.completo, false);
  ok('espera o restante do chunk');
}

console.log('\n3) Chunked com quebra de linha só \\n');
{
  const buf = Buffer.from('3\nabc\n0\n\n', 'latin1');
  const r = decodificarChunked(buf);
  assert.equal(r.completo, true);
  assert.equal(r.texto, 'abc');
  ok('aceita \\n e \\r\\n');
}

console.log('\nRESULTADO: TODOS OS TESTES DO CANAL PASSARAM');
