// O firmware tem simbolos C++ do iDCloud (CiD::IDCloud::IDCLoudEvent) e a
// string "https://%u.%u.%u.%u:%u". Isso e' o canal. Vamos extrair tudo.
import fs from 'fs';

const buf = fs.readFileSync('C:\\Producao\\Gerenciador REPs\\fw.bin');
const a = buf.toString('latin1');

const ctx = (p, antes = 120, depois = 200) =>
  a.slice(Math.max(0, p - antes), p + depois).replace(/[^\x20-\x7e]/g, '.');

console.log('=== 1) "https://%u.%u.%u.%u:%u" (o canal iDCloud) ===');
let i = a.indexOf('https://%u.%u.%u.%u:%u');
let n = 0;
while (i >= 0 && n < 4) { console.log(`  @${i}: ...${ctx(i, 200, 260)}...`); console.log(''); i = a.indexOf('https://%u.%u.%u.%u:%u', i + 1); n++; }

console.log('=== 2) sequencia "Looking for / Server found / Handshake" ===');
for (const k of ['Looking for', 'Server found', 'Handshake']) {
  const j = a.indexOf(k);
  console.log(`  "${k}" @${j}: ${j < 0 ? 'NAO ACHOU' : '...' + ctx(j, 90, 150) + '...'}`);
}

console.log('\n=== 3) todos os simbolos com IDCloud/iDCloud ===');
const simb = new Set();
for (const m of a.matchAll(/[A-Za-z0-9_]{0,60}(?:IDCloud|IdCloud|idcloud|iDCloud)[A-Za-z0-9_]{0,60}/g)) simb.add(m[0]);
[...simb].sort().forEach((s) => console.log('  ' + s));

console.log('\n=== 4) funcoes do client iDCloud (namespace CiD) ===');
const c = new Set();
for (const m of a.matchAll(/N3CiD[A-Za-z0-9_]{4,120}/g)) c.add(m[0]);
[...c].sort().forEach((s) => console.log('  ' + s));
