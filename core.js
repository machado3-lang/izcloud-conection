// core.js â€” Nucleo multi-tenant do iZCloud
// Banco "core" (izcloud_core) guarda as contas (clientes/tenants). Cada cliente
// tem o seu proprio schema MySQL (ex.: tenant_0007) == "numero do banco" do iDCloud.
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function cfg() {
  return {
    host: process.env.IDCLOUD_HOST || 'localhost',
    port: Number(process.env.IDCLOUD_PORT || 3306),
    user: process.env.IDCLOUD_USER || 'root',
    password: process.env.IDCLOUD_PASS || '',
    connectTimeout: 8000,
    charset: 'utf8mb4',
  };
}

function makePool(database) {
  const pool = mysql.createPool({
    ...cfg(),
    database,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 5,
  });
  // Evita que erros de conexao derrubem o processo (ex.: MySQL ausente/caiu).
  pool.on('error', (e) => console.error('[mysql] erro de pool:', e.code || e.message));
  return pool;
}

let _core = null;
export function getCorePool() {
  if (!_core) _core = makePool(process.env.CORE_DB || 'izcloud_core');
  return _core;
}

// Pool por tenant (cacheado). O "banco" do cliente e o schema.
const _tenants = new Map();
export function getTenantPool(schemaName) {
  if (!_tenants.has(schemaName)) {
    _tenants.set(schemaName, makePool(schemaName));
  }
  return _tenants.get(schemaName);
}

// Diagnostico: consegue conectar ao core e a tabela `contas` existe?
export async function verificarConexaoCore() {
  const out = { host: cfg().host, port: cfg().port, database: process.env.CORE_DB || 'izcloud_core', ok: false, tabela_contas: false, erro: null };
  try {
    const core = getCorePool();
    await core.query('SELECT 1');
    out.ok = true;
    const [t] = await core.query("SHOW TABLES LIKE 'contas'");
    out.tabela_contas = t.length > 0;
  } catch (e) {
    out.erro = e.message;
  }
  return out;
}

// Cria o banco/tabelas do core (idempotente). Conecta SEM database (pois o
// banco pode nao existir ainda), cria o `izcloud_core` e depois roda o DDL das
// tabelas na mesma conexao.
export async function inicializarCore() {
  const db = process.env.CORE_DB || 'izcloud_core';
  const conn = await mysql.createConnection({ ...cfg() });
  try {
    await conn.query('CREATE DATABASE IF NOT EXISTS ??', [db]);
    await conn.query('USE ??', [db]);
    const sql = fs.readFileSync(path.join(__dirname, 'schema_core.sql'), 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*(CREATE\s+DATABASE|USE)\b/i.test(l))
      .join('\n');
    // Comandos de exemplo commented-out no fim do arquivo NAO podem ir para o
    // MySQL: sem isso, um bloco de migracao comentada vira statement e o
    // servidor pode executar algo que ninguem pretendia.
    const statements = sql
      .split(';')
      .map((s) => s.split('\n').filter((l) => !/^\s*(--|#)/.test(l)).join('\n'))
      .map((s) => s.trim())
      .filter(Boolean);
    for (const st of statements) await conn.query(st);
  } finally {
    await conn.end();
  }
  await aplicarMigracoes();
  await garantirAdminBootstrap();
  return true;
}

// MySQL nao aceita `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (isso e do
// MariaDB), entao cada coluna nova e conferida em information_schema antes.
async function addColumnSeFaltar(conn, tabela, coluna, definicao) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [tabela, coluna]
  );
  if (r[0].n === 0) {
    await conn.query(`ALTER TABLE \`${tabela}\` ADD COLUMN ${coluna} ${definicao}`);
    console.log(`[migracao] ${tabela}.${coluna} criada`);
  }
}

// Colunas introduzidas depois do primeiro deploy. Idempotente: rodar em todo
// boot e o que mantem o banco da nuvem em dia sem migracao manual.
export async function aplicarMigracoes() {
  const db = process.env.CORE_DB || 'izcloud_core';
  const conn = await mysql.createConnection({ ...cfg(), database: db });
  try {
    await addColumnSeFaltar(conn, 'contas', 'papel', "ENUM('admin','cliente') NOT NULL DEFAULT 'cliente'");
    await addColumnSeFaltar(conn, 'contas', 'ultimo_login', 'DATETIME');
    await addColumnSeFaltar(conn, 'contas', 'criado_por', 'INT');
    await addColumnSeFaltar(conn, 'clientes', 'id_conta', 'INT');
    await addColumnSeFaltar(conn, 'clientes', 'razao_social', 'VARCHAR(160)');
    await addColumnSeFaltar(conn, 'clientes', 'endereco', 'VARCHAR(200)');
    await addColumnSeFaltar(conn, 'clientes', 'responsavel_nome', 'VARCHAR(120)');
    await addColumnSeFaltar(conn, 'clientes', 'responsavel_cpf', 'VARCHAR(20)');
  } finally {
    await conn.end();
  }
  return true;
}

// Cria (ou promove) a conta de administrador da plataforma a partir das env vars
// IZCLOUD_ADMIN_LOGIN / IZCLOUD_ADMIN_SENHA. Sem isso nao existe admin nenhum:
// o unico caminho seria o header IZCLOUD_ADMIN_KEY via curl.
export async function garantirAdminBootstrap() {
  const loginAdmin = process.env.IZCLOUD_ADMIN_LOGIN;
  const senhaAdmin = process.env.IZCLOUD_ADMIN_SENHA;
  if (!loginAdmin || !senhaAdmin) return null;

  const core = getCorePool();
  const [rows] = await core.query('SELECT id_conta, papel, ativo FROM contas WHERE login = ?', [loginAdmin]);
  if (rows.length) {
    if (rows[0].papel !== 'admin') {
      await core.query("UPDATE contas SET papel = 'admin' WHERE id_conta = ?", [rows[0].id_conta]);
      console.log(`[bootstrap] conta "${loginAdmin}" promovida a admin`);
    }
    return { id_conta: rows[0].id_conta, criado: false };
  }
  const [r] = await core.query(
    "INSERT INTO contas (login, senha_hash, nome, papel, ativo, criado_em) VALUES (?, ?, ?, 'admin', 1, NOW())",
    [loginAdmin, hashPassword(senhaAdmin), 'Administrador']
  );
  console.log(`[bootstrap] conta admin "${loginAdmin}" criada (id ${r.insertId})`);
  return { id_conta: r.insertId, criado: true };
}

// ---- Senha (scrypt, nativo do Node; sem dependencias externas) ----
export function hashPassword(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(senha, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(senha, salt, 64).toString('hex');
  if (h.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}

// Hash descartavel, com o mesmo custo do scrypt real. Usado quando o login nao
// existe: sem isso, um login inexistente responderia muito mais rapido que um
// existente e a diferenca de tempo revelaria quais logins sao validos.
const HASH_DUMMY = hashPassword(crypto.randomBytes(24).toString('hex'));
function custoFixo() {
  crypto.scryptSync('custo-fixo', HASH_DUMMY.split(':')[0], 64);
}

// ---- Scripts SQL (criacao de schema de tenant) ----
async function runScript(pool, sql) {
  const statements = sql
    .split(';')
    .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const st of statements) {
    await pool.query(st);
  }
}

// ---- CRUD de clientes (tenants) ----
// ---- Conta do cliente do iZCloud (login web; pode ter varias empresas) ----
export async function criarConta({ login, senha, nome, papel = 'cliente', criado_por = null }) {
  const core = getCorePool();
  const [ex] = await core.query('SELECT id_conta FROM contas WHERE login = ?', [login]);
  if (ex.length) throw new Error('Login ja existe');
  const [r] = await core.query(
    'INSERT INTO contas (login, senha_hash, nome, papel, criado_por, ativo, criado_em) VALUES (?, ?, ?, ?, ?, 1, NOW())',
    [login, hashPassword(senha), nome || null, papel === 'admin' ? 'admin' : 'cliente', criado_por]
  );
  return { id_conta: r.insertId, login };
}

export async function verificarConta(login, senha) {
  const core = getCorePool();
  const [rows] = await core.query(
    'SELECT id_conta, login, senha_hash, nome, papel, ativo FROM contas WHERE login = ?', [login]
  );
  if (!rows.length) { custoFixo(); return null; }
  const c = rows[0];
  if (!verifyPassword(senha, c.senha_hash)) return null;
  if (!c.ativo) return null;
  return { id_conta: c.id_conta, login: c.login, nome: c.nome, papel: c.papel || 'cliente' };
}

// Marca o ultimo login. Best-effort: falhar aqui nao pode impedir o login.
export async function registrarLogin(id_conta) {
  try {
    await getCorePool().query('UPDATE contas SET ultimo_login = NOW() WHERE id_conta = ?', [id_conta]);
  } catch (e) {
    console.error('[core] falha ao registrar ultimo_login:', e.message);
  }
}

export async function listarEmpresas(id_conta) {
  const core = getCorePool();
  const [rows] = await core.query(
    'SELECT id_cliente, schema_name, razao_social, nome_empresa, cnpj, endereco, responsavel_nome, responsavel_cpf FROM clientes WHERE id_conta = ? AND ativo = 1 ORDER BY id_cliente',
    [id_conta]
  );
  return rows.map(r => ({
    id_cliente: r.id_cliente, schema: r.schema_name,
    razao_social: r.razao_social, nome_empresa: r.nome_empresa,
    cnpj: r.cnpj, endereco: r.endereco, responsavel_nome: r.responsavel_nome, responsavel_cpf: r.responsavel_cpf,
  }));
}

// ---- Empresa (tenant) vinculada a uma conta ----
export async function criarEmpresa({ id_conta, login, senha, nome_empresa, razao_social, cnpj, endereco, responsavel_nome, responsavel_cpf }) {
  const core = getCorePool();
  if (!login) throw new Error('Login da empresa e obrigatorio (acesso via API)');
  const [ex] = await core.query('SELECT id_cliente FROM clientes WHERE login = ?', [login]);
  if (ex.length) throw new Error('Login da empresa ja existe');
  const [r] = await core.query(
    `INSERT INTO clientes (id_conta, login, senha_hash, schema_name, razao_social, nome_empresa, cnpj, endereco, responsavel_nome, responsavel_cpf, ativo, criado_em)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 1, NOW())`,
    [id_conta, login, hashPassword(senha), razao_social || null, nome_empresa || null, cnpj || null, endereco || null, responsavel_nome || null, responsavel_cpf || null]
  );
  const id = r.insertId;
  const schema = 'tenant_' + String(id).padStart(4, '0');
  await core.query('UPDATE clientes SET schema_name = ? WHERE id_cliente = ?', [schema, id]);
  await core.query(`CREATE DATABASE IF NOT EXISTS \`${schema}\``);
  const tp = getTenantPool(schema);
  await runScript(tp, fs.readFileSync(path.join(__dirname, 'schema_tenant.sql'), 'utf-8'));
  return { id_cliente: id, schema, login };
}

export async function atualizarEmpresa(id_conta, id_cliente, campos) {
  const core = getCorePool();
  const [own] = await core.query('SELECT id_cliente FROM clientes WHERE id_cliente = ? AND id_conta = ?', [id_cliente, id_conta]);
  if (!own.length) throw new Error('Empresa nao pertence a esta conta');
  const cols = [], vals = [];
  for (const k of ['razao_social', 'nome_empresa', 'cnpj', 'endereco', 'responsavel_nome', 'responsavel_cpf']) {
    if (campos[k] !== undefined) { cols.push(`${k} = ?`); vals.push(campos[k]); }
  }
  if (!cols.length) return { ok: true };
  vals.push(id_cliente);
  await core.query('UPDATE clientes SET ' + cols.join(', ') + ' WHERE id_cliente = ?', vals);
  return { ok: true };
}

export async function criarCliente({ login, senha, nome_empresa, cnpj, id_conta = null, razao_social = null, endereco = null, responsavel_nome = null, responsavel_cpf = null }) {
  const core = getCorePool();
  const [ex] = await core.query('SELECT id_cliente FROM clientes WHERE login = ?', [login]);
  if (ex.length) throw new Error('Login ja existe');

  const [r] = await core.query(
    `INSERT INTO clientes (id_conta, login, senha_hash, schema_name, razao_social, nome_empresa, cnpj, endereco, responsavel_nome, responsavel_cpf, ativo, criado_em)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 1, NOW())`,
    [id_conta, login, hashPassword(senha), razao_social, nome_empresa || null, cnpj || null, endereco, responsavel_nome, responsavel_cpf]
  );
  const id = r.insertId;
  const schema = 'tenant_' + String(id).padStart(4, '0');

  await core.query('UPDATE clientes SET schema_name = ? WHERE id_cliente = ?', [schema, id]);
  await core.query(`CREATE DATABASE IF NOT EXISTS \`${schema}\``);
  const tp = getTenantPool(schema);
  await runScript(tp, fs.readFileSync(path.join(__dirname, 'schema_tenant.sql'), 'utf-8'));
  return { id_cliente: id, schema, login };
}

export async function verificarCredenciais(login, senha) {
  const core = getCorePool();
  // 1) conta da empresa (tenant root) â€” tambem usada por sistemas externos
  const [rows] = await core.query(
    'SELECT id_cliente, login, senha_hash, schema_name, nome_empresa, ativo FROM clientes WHERE login = ?',
    [login]
  );
  if (rows.length) {
    const c = rows[0];
    if (c.ativo && verifyPassword(senha, c.senha_hash))
      return { id_cliente: c.id_cliente, schema_name: c.schema_name, login: c.login,
        nome_empresa: c.nome_empresa, tipo: 'empresa' };
    return null;
  }
  // 2) operador (usuario do tenant) â€” so para login web (JWT)
  const [ops] = await core.query(
    'SELECT id_usuario, id_cliente, schema_name, login, senha_hash, nome, nivel, ativo FROM usuarios WHERE login = ?',
    [login]
  );
  if (!ops.length) { custoFixo(); return null; }
  const u = ops[0];
  if (u.ativo && verifyPassword(senha, u.senha_hash))
    return { id_usuario: u.id_usuario, id_cliente: u.id_cliente, schema_name: u.schema_name, login: u.login,
      nome: u.nome, tipo: 'operador', nivel: u.nivel };
  return null;
}

// ---- Usuarios/operadores do tenant (multi-usuario por empresa) ----
export async function criarUsuario({ id_cliente, schema_name, login, senha, nome, nivel }) {
  const core = getCorePool();
  const [ex] = await core.query('SELECT id_usuario FROM usuarios WHERE login = ?', [login]);
  if (ex.length) throw new Error('Login de usuario ja existe');
  const [r] = await core.query(
    'INSERT INTO usuarios (id_cliente, schema_name, login, senha_hash, nome, nivel, ativo, criado_em) VALUES (?, ?, ?, ?, ?, ?, 1, NOW())',
    [id_cliente, schema_name, login, hashPassword(senha), nome || null, nivel || 'operador']
  );
  return { id_usuario: r.insertId, login };
}

export async function listarUsuarios(id_cliente) {
  const core = getCorePool();
  const [rows] = await core.query(
    'SELECT id_usuario, login, nome, nivel, ativo, criado_em FROM usuarios WHERE id_cliente = ? ORDER BY id_usuario',
    [id_cliente]
  );
  return rows;
}

export async function removerUsuario(id_cliente, id_usuario) {
  const core = getCorePool();
  await core.query('DELETE FROM usuarios WHERE id_cliente = ? AND id_usuario = ?', [id_cliente, id_usuario]);
  return { ok: true };
}

export async function listarClientes() {
  const core = getCorePool();
  const [rows] = await core.query(
    'SELECT id_cliente, login, schema_name, nome_empresa, cnpj, ativo, criado_em FROM clientes ORDER BY id_cliente'
  );
  return rows;
}

// =====================================================================
// ADMINISTRACAO DA PLATAFORMA (papel = 'admin')
// Estas funoes nao checam o acesso: quem chama e o middleware
// `authAdmin` (server.js), que exige JWT de conta com papel 'admin'.
// Nenhuma delas apaga dados — apenas desativa, para preservar os schemas
// tenant_XXXX e os dados de ponto.
// =====================================================================

// Lista todas as contas da plataforma + quantas empresas cada uma tem.
export async function listarContas() {
  const core = getCorePool();
  const [rows] = await core.query(
    `SELECT c.id_conta, c.login, c.nome, c.papel, c.ativo, c.criado_em, c.ultimo_login,
            (SELECT COUNT(*) FROM clientes e WHERE e.id_conta = c.id_conta) AS n_empresas,
            (SELECT COALESCE(GROUP_CONCAT(e.schema_name ORDER BY e.id_cliente), '')
               FROM clientes e WHERE e.id_conta = c.id_conta) AS schemas
       FROM contas c ORDER BY c.papel DESC, c.id_conta`
  );
  return rows.map((r) => ({
    id_conta: r.id_conta,
    login: r.login,
    nome: r.nome,
    papel: r.papel || 'cliente',
    ativo: !!r.ativo,
    criado_em: r.criado_em,
    ultimo_login: r.ultimo_login,
    n_empresas: Number(r.n_empresas) || 0,
    schemas: r.schemas ? String(r.schemas).split(',') : [],
  }));
}

// Quantos admins ativos existem (protege contra o ultimo admin se rebaixar).
export async function contarAdminsAtivos() {
  const core = getCorePool();
  const [rows] = await core.query(
    "SELECT COUNT(*) AS n FROM contas WHERE papel = 'admin' AND ativo = 1"
  );
  return Number(rows[0].n) || 0;
}

// Edita nome / papel / ativo. Nao permite deixar a plataforma sem admin.
export async function atualizarConta(id_conta, campos, adminAtual) {
  const core = getCorePool();
  const [rows] = await core.query('SELECT id_conta, login, papel, ativo FROM contas WHERE id_conta = ?', [id_conta]);
  if (!rows.length) throw new Error('Conta nao encontrada');
  const alvo = rows[0];

  const cols = [], vals = [];
  if (campos.nome !== undefined) { cols.push('nome = ?'); vals.push(campos.nome); }
  if (campos.papel !== undefined) {
    const papel = campos.papel === 'admin' ? 'admin' : 'cliente';
    if (papel !== alvo.papel) {
      if (id_conta === adminAtual) throw new Error('Voce nao pode alterar o proprio papel');
      if (alvo.papel === 'admin' && (papel !== 'admin' || campos.ativo === false)) {
        if ((await contarAdminsAtivos()) <= 1) throw new Error('E preciso manter ao menos 1 administrador ativo');
      }
      cols.push('papel = ?'); vals.push(papel);
    }
  }
  if (campos.ativo !== undefined) {
    const ativo = campos.ativo ? 1 : 0;
    if (ativo !== (alvo.ativo ? 1 : 0)) {
      if (id_conta === adminAtual && !ativo) throw new Error('Voce nao pode desativar a propria conta');
      if (!ativo && alvo.papel === 'admin' && (await contarAdminsAtivos()) <= 1) {
        throw new Error('E preciso manter ao menos 1 administrador ativo');
      }
      cols.push('ativo = ?'); vals.push(ativo);
    }
  }
  if (!cols.length) return { ok: true, sem_mudanca: true };
  vals.push(id_conta);
  await core.query('UPDATE contas SET ' + cols.join(', ') + ' WHERE id_conta = ?', vals);
  return { ok: true };
}

export async function resetarSenhaConta(id_conta, senha) {
  const core = getCorePool();
  // affectedRows seria 0 se a senha nova fosse igual a atual — por isso a
  // consulta de existencia vem antes.
  const [rows] = await core.query('SELECT id_conta FROM contas WHERE id_conta = ?', [id_conta]);
  if (!rows.length) throw new Error('Conta nao encontrada');
  await core.query('UPDATE contas SET senha_hash = ? WHERE id_conta = ?', [hashPassword(senha), id_conta]);
  return { ok: true };
}

// Todas as empresas da plataforma, com o login da conta dona.
export async function listarTodasEmpresas() {
  const core = getCorePool();
  const [rows] = await core.query(
    `SELECT e.id_cliente, e.id_conta, e.login AS login_api, e.schema_name, e.razao_social, e.nome_empresa,
            e.cnpj, e.endereco, e.responsavel_nome, e.responsavel_cpf, e.ativo, e.criado_em,
            c.login AS login_conta, c.nome AS nome_conta
       FROM clientes e LEFT JOIN contas c ON c.id_conta = e.id_conta
      ORDER BY e.id_cliente`
  );
  return rows.map((r) => ({
    id_cliente: r.id_cliente,
    id_conta: r.id_conta,
    login_api: r.login_api,
    schema: r.schema_name,
    razao_social: r.razao_social,
    nome_empresa: r.nome_empresa,
    cnpj: r.cnpj,
    endereco: r.endereco,
    responsavel_nome: r.responsavel_nome,
    responsavel_cpf: r.responsavel_cpf,
    ativo: !!r.ativo,
    criado_em: r.criado_em,
    login_conta: r.login_conta,
    nome_conta: r.nome_conta,
  }));
}

// Edita qualquer empresa (sem exigir que pertenca a conta do admin) e/ou
// desativa. Desativar preserva o schema e os dados.
export async function atualizarEmpresaAdmin(id_cliente, campos) {
  const core = getCorePool();
  const [rows] = await core.query('SELECT id_cliente FROM clientes WHERE id_cliente = ?', [id_cliente]);
  if (!rows.length) throw new Error('Empresa nao encontrada');
  const cols = [], vals = [];
  for (const k of ['razao_social', 'nome_empresa', 'cnpj', 'endereco', 'responsavel_nome', 'responsavel_cpf']) {
    if (campos[k] !== undefined) { cols.push(`${k} = ?`); vals.push(campos[k]); }
  }
  if (campos.ativo !== undefined) { cols.push('ativo = ?'); vals.push(campos.ativo ? 1 : 0); }
  if (!cols.length) return { ok: true, sem_mudanca: true };
  vals.push(id_cliente);
  await core.query('UPDATE clientes SET ' + cols.join(', ') + ' WHERE id_cliente = ?', vals);
  return { ok: true };
}

// ---- Auditoria ----
export async function auditar({ id_conta, acao, alvo = null, detalhes = null, ip = null }) {
  try {
    await getCorePool().query(
      'INSERT INTO admin_auditoria (id_conta, acao, alvo, detalhes, ip, criado_em) VALUES (?, ?, ?, ?, ?, NOW())',
      [id_conta, acao, alvo, detalhes ? String(detalhes).slice(0, 2000) : null, ip]
    );
  } catch (e) {
    console.error('[core] falha ao auditar:', e.message);
  }
}

export async function listarAuditoria(limite = 100) {
  const core = getCorePool();
  const n = Math.min(Math.max(Number(limite) || 100, 1), 500);
  const [rows] = await core.query(
    `SELECT a.id, a.acao, a.alvo, a.detalhes, a.ip, a.criado_em, c.login AS admin_login
       FROM admin_auditoria a LEFT JOIN contas c ON c.id_conta = a.id_conta
      ORDER BY a.id DESC LIMIT ${n}`
  );
  return rows;
}
