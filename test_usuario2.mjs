import { enviarUsuarios, proxyREP } from './repClient.js';

const ip = '192.168.100.132', porta = 443, usuario = 'admin', senha = 'admin';
const login = await proxyREP(ip, porta, 'login', { login: usuario, password: senha });
const sess = login.session;

// Restaurar usuario que foi removido acidentalmente antes
console.log('=== RESTAURAR 12345678901 (Claudio Koji Harada) ===');
await enviarUsuarios(ip, porta, [{
  pis: 12345678901, name: 'Claudio Koji Harada', registration: 1, code: 1, password: '1234', rfid: 0, barras: ''
}], '1510', usuario, senha);
const rest = await proxyREP(ip, porta, 'load_users', { session: sess, users_pis: [12345678901] });
console.log('restaurado:', rest.users?.[0]?.name);

// Adicionar usuario NOVO (PIS inexistente)
const novoPis = 99999999999;
console.log('\n=== ADD NOVO USER (1510 -> pis) ===');
const add = await enviarUsuarios(ip, porta, [{
  pis: novoPis, name: 'TESTE iZCLOUD', registration: 8888, code: 8888, password: '1234', rfid: 0, barras: ''
}], '1510', usuario, senha);
console.log(JSON.stringify(add).slice(0, 200));

console.log('\n=== LOAD NOVO USER ===');
const loaded = await proxyREP(ip, porta, 'load_users', { session: sess, users_pis: [novoPis] });
console.log('encontrado:', JSON.stringify(loaded.users?.[0] || loaded).slice(0, 250));

console.log('\n=== REMOVE NOVO USER ===');
await proxyREP(ip, porta, 'remove_users', { session: sess, users: [novoPis] });
const after = await proxyREP(ip, porta, 'load_users', { session: sess, users_pis: [novoPis] });
console.log('apos remover (deve estar vazio):', JSON.stringify(after).slice(0, 150));

console.log('\n=== CONFIRMAR 12345678901 AINDA PRESENTE ===');
const ok = await proxyREP(ip, porta, 'load_users', { session: sess, users_pis: [12345678901] });
console.log('presente:', ok.users?.[0]?.name || 'AUSENTE');
