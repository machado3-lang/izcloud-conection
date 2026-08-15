import { probe, baixarAfd } from './repClient.js';

const rep = { ip: '192.168.100.132', porta: 443, usuario: 'admin', senha: 'admin' };

try {
  console.log('=== PROBE ===');
  const info = await probe(rep.ip, rep.porta, rep.usuario, rep.senha);
  console.log(JSON.stringify(info, null, 2));

  console.log('\n=== BAIXAR AFD (sem periodo) ===');
  const afd = await baixarAfd(rep.ip, rep.porta, null, null, rep.usuario, rep.senha);
  const linhas = afd.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log('Total de linhas AFD:', linhas.length);
  console.log('Primeiras 5 linhas:');
  for (const l of linhas.slice(0, 5)) console.log('  [' + l.length + '] ' + l);
} catch (e) {
  console.error('ERRO:', e.message);
}
