import { proxyREP } from './repClient.js';

const ip = '192.168.100.132', porta = 443, usuario = 'admin', senha = 'admin';

const login = await proxyREP(ip, porta, 'login', { login: usuario, password: senha });
const sess = login.session;
console.log('sessao:', sess);

for (const cmd of ['get_about', 'get_info', 'get_system_information', 'get_configuration']) {
  try {
    const r = await proxyREP(ip, porta, cmd, { session: sess });
    console.log('\n=== ' + cmd + ' ===');
    console.log(JSON.stringify(r, null, 2).slice(0, 1500));
  } catch (e) {
    console.log('\n=== ' + cmd + ' ERRO: ' + e.message);
  }
}

// Tenta AFD de varias formas e mostra o que vier (cru)
for (const cmd of ['get_afd', 'get_afd.fcgi', 'afd']) {
  try {
    const r = await proxyREP(ip, porta, cmd, { session: sess });
    const txt = r?.afd || r?.raw || (typeof r === 'string' ? r : '');
    console.log('\n=== ' + cmd + ' (len=' + (txt ? String(txt).length : 0) + ') ===');
    console.log(String(txt).slice(0, 600));
  } catch (e) {
    console.log('\n=== ' + cmd + ' ERRO: ' + e.message);
  }
}
