import { proxyREP } from './repClient.js';

const ip = '192.168.100.132', porta = 443, usuario = 'admin', senha = 'admin';
const login = await proxyREP(ip, porta, 'login', { login: usuario, password: senha });
const sess = login.session;

// Tenta get_afd com periodo pequeno (formato YYYY-MM-DD, como no Pontoweb)
const tentativas = [
  { data_inicio: '2025-06-01', data_fim: '2025-06-30' },
  { data_inicio: '2025-01-01', data_fim: '2025-12-31' },
  {},
];

for (const params of tentativas) {
  try {
    const r = await proxyREP(ip, porta, 'get_afd', { session: sess, ...params });
    const txt = r?.afd || r?.raw || (typeof r === 'string' ? r : '');
    if (txt && String(txt).trim().length) {
      const linhas = String(txt).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      console.log(`\n=== get_afd ${JSON.stringify(params)} -> ${linhas.length} linhas ===`);
      for (const l of linhas.slice(0, 8)) console.log('  [' + l.length + '] ' + l);
      const amostra = linhas.find(l => l[9] === '3');
      if (amostra) console.log('  -> tipo 3 na pos14 =', amostra[14], '=>', amostra[14] === '-' ? '671' : '1510');
      break;
    } else {
      console.log(`\n=== get_afd ${JSON.stringify(params)} -> vazio (raw keys: ${Object.keys(r||{}).join(',')}) ===`);
    }
  } catch (e) {
    console.log(`\n=== get_afd ${JSON.stringify(params)} ERRO: ${e.message}`);
  }
}
