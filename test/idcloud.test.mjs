// Testes do parser HTTP do canal iDCloud: corpo com Content-Length e chunked.
// O REP manda o AFD grande em Transfer-Encoding: chunked; sem isso o canal
// lia "sem corpo" e gravava 0 batidas.
import assert from 'node:assert/strict';
import { decodificarChunked, SessaoRep } from '../idcloudServer.js';

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

console.log('\n4) Resposta Connection: close sem Content-Length');
{
  const listeners = {};
  const socket = {
    destroyed: false,
    on(ev, fn) { listeners[ev] = fn; },
    write() {},
    end() {},
  };
  const rep = new SessaoRep(socket);
  rep.primeira = false;
  const p = rep.pedir('get_afd', { session: 'x' }, { binario: true });
  const corpo = '00000000130511202610200701756811724A72\r\n';
  listeners.data(Buffer.from(
    'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/octet-stream\r\n\r\n' +
    corpo, 'latin1'));
  listeners.close();
  const r = await p;
  assert.equal(r.status, 200);
  assert.equal(r.binario, corpo);
  ok('corpo delimitado pelo close e devolvido');
}

console.log('\nRESULTADO: TODOS OS TESTES DO CANAL PASSARAM');
