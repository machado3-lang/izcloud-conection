// test_rep_afd.mjs — diagnostico SOMENTE LEITURA do REP real.
//
//   node test_rep_afd.mjs [IP] [porta] [usuario] [senha]
//   REP_IP=192.168.100.132 REP_PORT=5432 node test_rep_afd.mjs
//
// Mostra firmware (decimal e display), AFD com/sem limit, empresa e usuarios
// com templates. Nao grava no banco e nao altera o aparelho.
import { proxyREP } from './repClient.js';

const IP = process.argv[2] || process.env.REP_IP || '192.168.100.132';
const PORT = Number(process.argv[3] || process.env.REP_PORT || 5432);
const USER = process.argv[4] || process.env.REP_USER || 'admin';
const PASS = process.argv[5] || process.env.REP_PASS || 'admin';

const log = (...a) => console.log(...a);
const linhas = (txt) => String(txt || '').split(/\r?\n/).filter((l) => l.trim());
const batidas = (ls) => ls.filter((l) => l[9] === '3');

try {
  log(`Conectando em ${IP}:${PORT} ...`);
  const login = await proxyREP(IP, PORT, 'login', { login: USER, password: PASS });
  const session = login?.session;
  if (!session) throw new Error('login sem session');

  // v1048: get_about exige session.
  const about = await proxyREP(IP, PORT, 'get_about', { session });
  const fw = Number(about?.versionFW || 0);
  const mrp = Number(about?.versionMRP || 0);
  log('\n[get_about]', JSON.stringify(about));
  log(`  serial: ${about?.nSerie}`);
  log(`  firmware: ${fw} decimal = display ${fw ? fw.toString(16).toUpperCase() : '-'} (0x${fw ? fw.toString(16).toUpperCase() : '-'})`);
  log(`  MRP: ${mrp} decimal = display ${mrp ? mrp.toString(16).toUpperCase() : '-'} (0x${mrp ? mrp.toString(16).toUpperCase() : '-'})`);

  const info = await proxyREP(IP, PORT, 'get_system_information', { session });
  log('\n[get_system_information]', JSON.stringify(info));

  const afd1000 = await proxyREP(IP, PORT, 'get_afd', { session, limit: 1000, offset: 0 });
  const l1000 = linhas(afd1000?.afd || afd1000?.raw || '');
  const b1000 = batidas(l1000);
  log(`\n[get_afd limit=1000] linhas=${l1000.length} batidas=${b1000.length}`);

  const afdFull = await proxyREP(IP, PORT, 'get_afd', { session });
  const lFull = linhas(afdFull?.afd || afdFull?.raw || '');
  const bFull = batidas(lFull);
  log(`[get_afd sem limit]    linhas=${lFull.length} batidas=${bFull.length} bytes=${String(afdFull?.afd || afdFull?.raw || '').length}`);
  log(`  1a batida: ${(bFull[0] || '').slice(0, 45)}`);
  log(`  ultima:    ${(bFull.at(-1) || '').slice(0, 45)}`);

  const company = await proxyREP(IP, PORT, 'load_company', { session });
  log('\n[load_company]', JSON.stringify(company));

  const users = await proxyREP(IP, PORT, 'load_users', { session, limit: 100, offset: 0, templates: true });
  const lista = users?.users || [];
  let comTpl = 0;
  for (const u of lista) if (Array.isArray(u.templates) && u.templates.length) comTpl++;
  log(`\n[load_users] usuarios=${lista.length} (count=${users?.count ?? '-'}) com_templates=${comTpl}`);
  const curtos = lista.filter((u) => String(u.pis || u.cpf || '').replace(/\D/g, '').length <= 6);
  log(`  numeros curtos (codigo iDCloud/teste): ${curtos.length}`);
  for (const u of curtos) log(`    - ${u.name} (pis=${u.pis ?? '-'} cpf=${u.cpf ?? '-'})`);
  if (lista[0]) log('  1o usuario:', JSON.stringify({ ...lista[0], templates: undefined }).slice(0, 500));

  log('\nDiagnostico concluido (nada foi alterado).');
  process.exit(0);
} catch (e) {
  console.error('\nFalha:', e.message || e);
  process.exit(1);
}
