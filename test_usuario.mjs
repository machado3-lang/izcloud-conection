import { enviarUsuarios, proxyREP } from './repClient.js';

const ip = '192.168.100.132', porta = 443, usuario = 'admin', senha = 'admin';
const pis = 12345678901; // PIS de teste

// 1) Enviar usuario (1510 -> campo pis)
console.log('=== ADD USER (1510 -> pis) ===');
const add = await enviarUsuarios(ip, porta, [{
  pis, name: 'TESTE iZCLOUD', registration: 9999, code: 9999, password: '1234', rfid: 0, barras: ''
}], '1510', usuario, senha);
console.log(JSON.stringify(add, null, 2));

// 2) Confirmar que foi cadastrado
console.log('\n=== LOAD USER ===');
const sess = (await proxyREP(ip, porta, 'login', { login: usuario, password: senha })).session;
const loaded = await proxyREP(ip, porta, 'load_users', { session: sess, users_pis: [pis] });
console.log('encontrado:', JSON.stringify(loaded).slice(0, 300));

// 3) Remover para deixar o REP de testes limpo
console.log('\n=== REMOVE USER ===');
const rm = await proxyREP(ip, porta, 'remove_users', { session: sess, users: [pis] });
console.log(JSON.stringify(rm, null, 2));
