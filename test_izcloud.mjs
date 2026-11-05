// test_izcloud.mjs — guia interativo para testar o iZCloud (iDFace + iDClass).
//
// Uso:
//   node test_izcloud.mjs
//   node test_izcloud.mjs https://SEU_HOST login senha
//
// Variaveis opcionais: IZCLOUD_URL, IZCLOUD_LOGIN, IZCLOUD_SENHA, IZCLOUD_EMPRESA
// (schema, ex.: tenant_0001). Se houver mais de uma empresa, o script pergunta.
//
// O script faz login em /api/auth/login e usa Bearer + X-Empresa. Tambem
// funciona com operador (a empresa ja vem no token).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const rl = readline.createInterface({ input, output });
const perguntar = async (texto, padrao = '') => {
  const r = (await rl.question(texto)).trim();
  return r || padrao;
};

const argUrl = process.argv[2];
const argLogin = process.argv[3];
const argSenha = process.argv[4];

let BASE = (argUrl || process.env.IZCLOUD_URL || '').replace(/\/+$/, '');
if (!BASE) BASE = (await perguntar('URL do iZCloud (ex.: https://izcloud.com.br): ')).replace(/\/+$/, '');
if (!BASE) { console.error('URL obrigatoria.'); process.exit(1); }

const login = argLogin || process.env.IZCLOUD_LOGIN || await perguntar('Login da plataforma: ');
const senha = argSenha || process.env.IZCLOUD_SENHA || await perguntar('Senha: ');
if (!login || !senha) { console.error('Login/senha obrigatorios.'); process.exit(1); }

let auth = {};
let empresa = null;

async function api(caminho, { method = 'GET', body, raw = false } = {}) {
  const headers = { ...auth };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + caminho, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`${res.status} ${texto.slice(0, 500)}`);
  }
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

async function apiLogin() {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, senha }),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${texto.slice(0, 500)}`);
  return JSON.parse(texto);
}

function linha(cabecalhos, larguras, valores) {
  return cabecalhos.map((h, i) => String(h).padEnd(larguras[i])).join(' | ');
}

function imprimirTabela(rows, colunas) {
  if (!rows.length) { console.log('  (vazio)'); return; }
  const larguras = colunas.map((c) => Math.max(
    c.titulo.length,
    ...rows.map((r) => String(c.valor(r) ?? '').slice(0, c.max || 40).length)
  ));
  console.log('  ' + linha(colunas.map((c) => c.titulo), larguras));
  console.log('  ' + larguras.map((w) => '-'.repeat(w)).join('-+-'));
  for (const r of rows) {
    console.log('  ' + linha(
      colunas.map((c) => String(c.valor(r) ?? '').slice(0, c.max || 40)),
      larguras
    ));
  }
}

async function escolherDaLista(rows, rotulo, idFn) {
  if (!rows.length) { console.log(`Nenhum ${rotulo} cadastrado.`); return null; }
  const id = Number(await perguntar(`ID do ${rotulo}: `));
  const achado = rows.find((r) => Number(idFn(r)) === id);
  if (!achado) { console.log('ID nao encontrado.'); return null; }
  return achado;
}

async function listarDispositivos() {
  const rows = await api('/api/idface/dispositivos');
  console.log('\nDispositivos iDFace:');
  imprimirTabela(rows, [
    { titulo: 'ID', valor: (r) => r.id },
    { titulo: 'Nome', valor: (r) => r.nome, max: 24 },
    { titulo: 'Portaria', valor: (r) => r.portaria },
    { titulo: 'device_id', valor: (r) => r.device_id, max: 20 },
    { titulo: 'Serial', valor: (r) => r.serial },
    { titulo: 'Marcacoes', valor: (r) => r.marcacoes },
    { titulo: 'Pendentes', valor: (r) => r.pendentes },
    { titulo: 'Ultimo contato', valor: (r) => r.ultimo_contato, max: 19 },
  ]);
  return rows;
}

async function criarDispositivo() {
  const nome = await perguntar('Nome do dispositivo (ex.: iDFace Recepcao): ', 'iDFace');
  const idEquipamentoTxt = await perguntar('id_Equipamento vinculado (opcional, Enter pula): ');
  const portaria = await perguntar('Portaria [595/671] (padrao 671): ', '671');
  const body = {
    nome,
    portaria: portaria === '595' ? '595' : '671',
    idEquipamento: idEquipamentoTxt ? Number(idEquipamentoTxt) : null,
  };
  const r = await api('/api/idface/dispositivos', { method: 'POST', body });
  console.log('\nDispositivo criado:');
  console.log('  id:', r.id);
  console.log('  token:', r.token);
  console.log('  push_base:', r.push_base);
  console.log('  push_url :', r.push_url);
  console.log('\nAgora configure o iDFace na rede local:');
  console.log(`  node config_idface_push.mjs 192.168.100.138 ${r.push_base}`);
  console.log('\n(Se o IP do iDFace for outro, troque 192.168.100.138.)');
  return r;
}

async function coletar() {
  const rows = await listarDispositivos();
  const disp = await escolherDaLista(rows, 'dispositivo', (r) => r.id);
  if (!disp) return;

  console.log('\nO que coletar?');
  console.log('  1) AFD (arquivo do equipamento)');
  console.log('  2) access_logs (marcacoes em tempo real)');
  console.log('  3) usuarios + CPF (snapshot para mapeamento)');
  const tipoOp = await perguntar('Opcao (1/2/3): ', '1');
  const tipo = tipoOp === '2' ? 'logs' : tipoOp === '3' ? 'usuarios' : 'afd';

  const body = { tipo, formato: disp.portaria || '671' };
  if (tipo === 'afd') {
    console.log('\nModo do AFD:');
    console.log('  1) completo');
    console.log('  2) a partir de um NSR');
    console.log('  3) a partir de uma data');
    const modoOp = await perguntar('Opcao (1/2/3): ', '1');
    body.modo = modoOp === '2' ? 'nsr' : modoOp === '3' ? 'data' : 'completo';
    if (body.modo === 'nsr') body.nsr = Number(await perguntar('NSR inicial: '));
    if (body.modo === 'data') body.dataInicio = await perguntar('Data inicial (YYYY-MM-DD): ');
    const fmt = await perguntar(`Formato [595/671] (padrao ${body.formato}): `, body.formato);
    body.formato = fmt === '595' ? '595' : '671';
  }

  const r = await api(`/api/idface/dispositivos/${disp.id}/coletar`, { method: 'POST', body });
  console.log('\nComando(s) enfileirado(s):');
  for (const c of r.comandos || []) {
    console.log(`  #${c.id} ${c.endpoint} ${c.query_string ? '(' + c.query_string + ')' : ''} body=${c.body}`);
  }
  console.log('\nO equipamento executa no proximo poll (o periodo esta no iDFace).');
  console.log('Depois use a opcao 5 (marcacoes) ou 6/7 (arquivos).');
}

async function verMarcacoes() {
  const rows = await listarDispositivos();
  const disp = await escolherDaLista(rows, 'dispositivo', (r) => r.id);
  if (!disp) return;
  const inicio = await perguntar('Data inicial (YYYY-MM-DD, Enter = tudo): ');
  const fim = await perguntar('Data final (YYYY-MM-DD, Enter = tudo): ');
  const q = new URLSearchParams();
  if (inicio) q.set('inicio', inicio);
  if (fim) q.set('fim', `${fim} 23:59:59`);
  q.set('limite', '200');
  const marcas = await api(`/api/idface/dispositivos/${disp.id}/marcacoes?${q}`);
  console.log(`\nMarcacoes (${marcas.length}):`);
  imprimirTabela(marcas, [
    { titulo: 'Data/hora', valor: (m) => m.data_hora, max: 19 },
    { titulo: 'Documento', valor: (m) => m.documento },
    { titulo: 'device_user_id', valor: (m) => m.device_user_id, max: 16 },
    { titulo: 'Matricula/PIS', valor: (m) => m.usuario_registration },
    { titulo: 'Nome', valor: (m) => m.usuario_nome, max: 24 },
    { titulo: 'Origem', valor: (m) => m.origem },
    { titulo: 'NSR', valor: (m) => m.nsr },
  ]);
}

async function baixarArquivoIdface() {
  const rows = await api('/api/idface/arquivos');
  console.log('\nArquivos AFD do iDFace:');
  imprimirTabela(rows, [
    { titulo: 'ID', valor: (r) => r.id },
    { titulo: 'Formato', valor: (r) => r.formato },
    { titulo: 'Serial', valor: (r) => r.serial },
    { titulo: 'Tamanho', valor: (r) => r.tamanho },
    { titulo: 'Criado', valor: (r) => r.criado_em, max: 19 },
  ]);
  if (!rows.length) return;
  const id = Number(await perguntar('ID do arquivo para baixar: '));
  const alvo = rows.find((r) => Number(r.id) === id);
  if (!alvo) { console.log('ID nao encontrado.'); return; }
  const res = await api(`/api/idface/arquivos/${id}/download`, { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  const nome = path.join(process.cwd(), `AFD_idface_${id}.txt`);
  fs.writeFileSync(nome, buf);
  console.log(`\nSalvo em: ${nome} (${buf.length} bytes)`);
}

async function listarReps() {
  const rows = await api('/api/reps');
  console.log('\nREPs iDClass cadastrados:');
  imprimirTabela(rows, [
    { titulo: 'id_Equipamento', valor: (r) => r.id_Equipamento, max: 18 },
    { titulo: 'Serial', valor: (r) => r.Serial, max: 20 },
    { titulo: 'Nome', valor: (r) => r.Nome, max: 24 },
    { titulo: 'REPType', valor: (r) => r.REPType },
    { titulo: 'IP', valor: (r) => r.IpAddress },
    { titulo: 'Modo', valor: (r) => r.ModoConexao },
  ]);
  return rows;
}

async function baixarAfdIdclass() {
  const reps = await listarReps();
  const rep = await escolherDaLista(reps, 'REP iDClass', (r) => r.id_Equipamento);
  if (!rep) return;

  console.log('\nModo:');
  console.log('  1) completo');
  console.log('  2) a partir de um NSR');
  console.log('  3) a partir de uma data');
  const op = await perguntar('Opcao (1/2/3): ', '1');
  const modo = op === '2' ? 'nsr' : op === '3' ? 'data' : 'completo';
  const formato = await perguntar(`Formato [1510/671] (padrao ${rep.REPType || '1510'}): `, rep.REPType || '1510');

  const q = new URLSearchParams({
    idEquipamento: String(rep.id_Equipamento),
    modo,
    formato: formato === '671' ? '671' : '1510',
  });
  if (modo === 'nsr') q.set('nsr', await perguntar('NSR inicial: '));
  if (modo === 'data') q.set('dataInicio', await perguntar('Data inicial (YYYY-MM-DD): '));

  const res = await api(`/api/afd/download?${q}`, { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  const nome = path.join(process.cwd(), `AFD_idclass_${rep.id_Equipamento}_${modo}.txt`);
  fs.writeFileSync(nome, buf);
  console.log(`\nSalvo em: ${nome} (${buf.length} bytes)`);
}

async function listarArquivosIdclass() {
  const rows = await api('/api/afd/arquivos');
  console.log('\nArquivos AFD no iZCloud:');
  imprimirTabela(rows, [
    { titulo: 'ID', valor: (r) => r.id },
    { titulo: 'Origem', valor: (r) => r.origem },
    { titulo: 'Formato', valor: (r) => r.formato },
    { titulo: 'id_Equipamento', valor: (r) => r.id_Equipamento, max: 18 },
    { titulo: 'id_dispositivo', valor: (r) => r.id_dispositivo },
    { titulo: 'Tamanho', valor: (r) => r.tamanho },
    { titulo: 'Criado', valor: (r) => r.criado_em, max: 19 },
  ]);
  if (!rows.length) return;
  const id = Number(await perguntar('ID do arquivo para baixar (Enter = voltar): '));
  if (!id) return;
  const res = await api(`/api/afd/arquivos/${id}/download`, { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  const nome = path.join(process.cwd(), `AFD_arquivo_${id}.txt`);
  fs.writeFileSync(nome, buf);
  console.log(`\nSalvo em: ${nome} (${buf.length} bytes)`);
}

async function cadastrarRep() {
  console.log('\nCadastrar REP iDClass (REP-C)');
  console.log('  1) Sondar (o servidor do iZCloud precisa alcançar o REP)');
  console.log('  2) Cadastrar manual (só o número de série)');
  const op = await perguntar('Opcao (1/2): ', '2');

  let serial = '';
  let tipo = '1510';
  let ip = '';
  let porta = 443;
  let pass = 'admin';

  if (op === '1') {
    ip = await perguntar('IP do REP: ');
    porta = Number(await perguntar('Porta do web server (443/5432): ', '443'));
    const usuario = await perguntar('Usuario: ', 'admin');
    const senhaRep = await perguntar('Senha: ', 'admin');
    try {
      const r = await api('/api/reps/probe', {
        method: 'POST', body: { ip, porta, usuario, senha: senhaRep },
      });
      console.log('\nSondagem OK:', JSON.stringify(r));
      serial = r.serial || '';
      tipo = r.portaria || tipo;
    } catch (e) {
      console.log('\nSondagem falhou (normal se o iZCloud esta na nuvem e o REP na LAN):');
      console.log('  ' + e.message);
      console.log('  Siga no modo manual: informe o numero de serie do REP.');
    }
  }

  serial = await perguntar(`Numero de serie (id_Equipamento)${serial ? ` [${serial}]` : ''}: `, serial);
  if (!serial) { console.log('Sem numero de serie nao da para cadastrar.'); return; }

  const nome = await perguntar('Nome do REP: ', `REP ${serial}`);
  ip = await perguntar('IP do REP (para nuvem_puxa; Enter = vazio): ', ip);
  porta = Number(await perguntar('Porta do web server: ', String(porta || 443)));
  pass = await perguntar('Passcode/senha do REP: ', pass || 'admin');
  tipo = await perguntar(`REPType [1510/595/671] (padrao ${tipo}): `, tipo);
  const modo = await perguntar('Modo [nuvem_puxa/rep_empurra] (padrao nuvem_puxa): ', 'nuvem_puxa');

  const r = await api('/api/reps', {
    method: 'POST',
    body: {
      serial, Nome: nome, IpAddress: ip || null, Porta: porta, Passcode: pass,
      REPType: tipo, ModoConexao: modo,
    },
  });
  console.log(`\nREP cadastrado: id_Equipamento=${r.id_Equipamento}, serial=${r.serial}`);
  console.log('Agora a opcao 8 lista esse REP.');
  console.log('Lembrete: para baixar o AFD, o iZCloud precisa alcancar o IP do REP.');
  console.log('Se o iZCloud estiver na nuvem e o REP na LAN (192.168.x.x), rode o');
  console.log('iZCloud localmente e use http://localhost:3100 neste script.');
}

async function status() {
  const h = await fetch(BASE + '/api/health').then((r) => r.json()).catch((e) => ({ erro: e.message }));
  console.log('\n/api/health:', JSON.stringify(h));
  try {
    const reps = await api('/api/reps');
    console.log(`Acesso ao tenant OK. REPs cadastrados: ${reps.length}`);
  } catch (e) {
    console.log('Falha ao acessar o tenant:', e.message);
  }
  try {
    const d = await api('/api/idface/dispositivos');
    console.log(`iDFace: ${d.length} dispositivo(s).`);
  } catch (e) {
    console.log('Falha ao acessar iDFace:', e.message);
  }
}

// ---------- inicio ----------
console.log(`\niZCloud: ${BASE}`);
const r = await apiLogin();
auth = { Authorization: `Bearer ${r.token}` };
const empresas = r.contas || [];
if (!empresas.length) {
  console.error('O login nao retornou nenhuma empresa.');
  process.exit(1);
}
const empresaEnv = process.env.IZCLOUD_EMPRESA;
empresa = empresaEnv ? empresas.find((e) => e.schema === empresaEnv) : null;
if (!empresa && empresas.length === 1) empresa = empresas[0];
if (!empresa) {
  console.log('\nEmpresas disponiveis:');
  empresas.forEach((e, i) => console.log(`  ${i + 1}) ${e.nome_empresa || e.razao_social || e.schema} (${e.schema})`));
  const idx = Number(await perguntar('Numero da empresa: ', '1')) - 1;
  empresa = empresas[idx] || empresas[0];
}
auth['X-Empresa'] = empresa.schema;
console.log(`Empresa: ${empresa.nome_empresa || empresa.razao_social || empresa.schema} (${empresa.schema})`);

while (true) {
  console.log('\n========== MENU ==========');
  console.log('1) Status do iZCloud');
  console.log('2) Listar dispositivos iDFace');
  console.log('3) Criar dispositivo iDFace (mostra URL de push)');
  console.log('4) Disparar coleta iDFace (AFD / logs / usuarios)');
  console.log('5) Ver marcacoes do iDFace');
  console.log('6) Baixar AFD bruto do iDFace');
  console.log('7) Listar REPs iDClass');
  console.log('8) Baixar AFD do iDClass (completo / NSR / data)');
  console.log('9) Listar/baixar arquivos AFD salvos');
  console.log('10) Cadastrar REP iDClass (REP-C)');
  console.log('0) Sair');
  const op = await perguntar('Opcao: ', '0');
  try {
    if (op === '1') await status();
    else if (op === '2') await listarDispositivos();
    else if (op === '3') await criarDispositivo();
    else if (op === '4') await coletar();
    else if (op === '5') await verMarcacoes();
    else if (op === '6') await baixarArquivoIdface();
    else if (op === '7') await listarReps();
    else if (op === '8') await baixarAfdIdclass();
    else if (op === '9') await listarArquivosIdclass();
    else if (op === '10') await cadastrarRep();
    else if (op === '0') break;
    else console.log('Opcao invalida.');
  } catch (e) {
    console.log('\nERRO:', e.message);
  }
}
rl.close();
console.log('\nAte mais.');
