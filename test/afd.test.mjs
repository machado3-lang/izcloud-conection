// Testes do parser AFD com linhas REAIS do iDFace 6.26.4 (05/11/2026).
//
// O iDFace usa o `id` do usuário como documento (não a matrícula) e, no layout
// 671, envia o documento com 12 dígitos (zero à esquerda) antes do CRC. O parser
// antigo cortava o último dígito.
import assert from 'node:assert/strict';
import { detectarTipo, parseLinhaBatida, extrairDocumento, gerarPorPeriodo } from '../afd.js';

const ok = (m) => console.log('  ok  ' + m);

// Linhas reais exportadas pelo iDFace:
// 595 (PIS/1510-like): NSR 1, 05/11/2026 10:20, doc 070175681172, CRC 4A72
const L595 = '00000000130511202610200701756811724A72';
// 671 (CPF): NSR 1, 2026-11-05T10:20:00-0400, doc 070175681172, CRC ADB4
const L671 = '00000000132026-11-05T10:20:00-0400070175681172ADB4';
// 671 padrão sem o zero de preenchimento (11 dígitos + CRC)
const L671_STD = '00000000132026-11-05T10:20:00-040070175681172ADB4';

console.log('\n1) Detecção de layout');
assert.equal(detectarTipo(L595), '1510');
assert.equal(detectarTipo(L671), '671');
assert.equal(detectarTipo(L671_STD), '671');
ok('595 detectado como 1510; 671 com ISO detectado como 671');

console.log('\n2) Documento no 595 (PIS)');
assert.equal(extrairDocumento(L595), '70175681172');
const a = parseLinhaBatida(L595);
assert.equal(a.tipo, '1510');
assert.equal(a.documento, '70175681172');
assert.equal(a.nsr, '000000001');
assert.equal(a.dataHora.getFullYear(), 2026);
assert.equal(a.dataHora.getMonth(), 10);
assert.equal(a.dataHora.getDate(), 5);
assert.equal(a.dataHora.getHours(), 10);
assert.equal(a.dataHora.getMinutes(), 20);
ok('PIS 70175681172, 05/11/2026 10:20');

console.log('\n3) Documento no 671 (CPF) com zero à esquerda do iDFace');
assert.equal(extrairDocumento(L671), '70175681172');
const b = parseLinhaBatida(L671);
assert.equal(b.tipo, '671');
assert.equal(b.documento, '70175681172');
assert.equal(b.nsr, '000000001');
assert.equal(b.dataHora.getFullYear(), 2026);
assert.equal(b.dataHora.getMonth(), 10);
assert.equal(b.dataHora.getDate(), 5);
assert.equal(b.dataHora.getHours(), 10);
assert.equal(b.dataHora.getMinutes(), 20);
ok('CPF 70175681172 (não 07017568117), 05/11/2026 10:20');

console.log('\n4) Documento no 671 padrão (11 dígitos, sem zero)');
assert.equal(extrairDocumento(L671_STD), '70175681172');
assert.equal(parseLinhaBatida(L671_STD).documento, '70175681172');
ok('layout padrão de 11 dígitos continua funcionando');

console.log('\n5) Linha que não é batida é ignorada');
assert.equal(parseLinhaBatida('0000000001100000000000000000000000000ControliD'), null);
assert.equal(extrairDocumento('0000000001100000000000000000000000000ControliD'), '');
ok('header/trailer não viram pessoa');

console.log('\n6) Geração AFD 1510 com empregador (header/trailer oficiais)');
const g = gerarPorPeriodo({
  linhasCruas: [L595],
  serial: '04408801109364847',
  dataInicio: '2026-11-05',
  dataFim: '2026-11-05',
  empregador: {
    CNPJ_CPF: '13133714000110', CEI: '', RazaoSocial: 'ACF MACHADO',
  },
});
const ls = g.texto.split(/\r?\n/);
assert.equal(g.total, 1);
assert.equal(ls[0].length, 232);
assert.equal(ls[0].slice(0, 10), '0000000001');
assert.equal(ls[0][10], '1');                       // CNPJ
assert.equal(ls[0].slice(11, 25), '13133714000110');
assert.equal(ls[0].slice(37, 187).trim(), 'ACF MACHADO');
assert.equal(ls[0].slice(187, 204), '04408801109364847');
assert.equal(ls[0].slice(204, 212), '05112026');
assert.equal(ls[2].length, 46);
assert.equal(ls[2].slice(18, 27), '000000001');      // 1 registro tipo 3
ok('header 232 chars com CNPJ/razão/serial/data; trailer 46 chars');

console.log('\n7) AFD 671 não é regerado (deve vir bruto do REP)');
assert.throws(
  () => gerarPorPeriodo({ linhasCruas: [L671], formato: '671' }),
  /671/
);
ok('geração 671 recusada com mensagem clara');

console.log('\nRESULTADO: TODOS OS TESTES PASSARAM');
