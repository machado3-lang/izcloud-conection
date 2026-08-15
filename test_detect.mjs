import { probe, baixarAfd } from './repClient.js';

const rep = { ip: '192.168.100.132', porta: 443, usuario: 'admin', senha: 'admin' };

console.log('=== PROBE (auto-detect 1510/671) ===');
const info = await probe(rep.ip, rep.porta, rep.usuario, rep.senha);
console.log(JSON.stringify(info, null, 2));

console.log('\n=== BAIXAR AFD (periodo 2025-06-01..2025-06-30, formato nativo) ===');
const texto = await baixarAfd(rep.ip, rep.porta, '2025-06-01', '2025-06-30', rep.usuario, rep.senha, info.portaria);
const linhas = texto.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
console.log('Total linhas:', linhas.length);
for (const l of linhas.slice(0, 5)) console.log('  [' + l.length + '] ' + l.slice(0, 60));
const amostra = linhas.find(l => l[9] === '3');
console.log('  tipo 3 pos14 =', amostra ? amostra[14] : 'n/a', '=>', amostra ? (amostra[14] === '-' ? '671' : '1510') : '');
