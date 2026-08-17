// core.js — Nucleo multi-tenant do iZCloud
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
    acquireTimeout: 8000,
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
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const st of statements) await conn.query(st);
  } finally {
    await conn.end();
  }
  return true;
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
export async function criarConta({ login, senha, nome }) {
  const core = getCorePool();
  const [ex] = await core.query('SELECT id_conta FROM contas WHERE login = ?', [login]);
  if (ex.length) throw new Error('Login ja existe');
  const [r] = await core.query(
    'INSERT INTO contas (login, senha_hash, nome, ativo, criado_em) VALUES (?, ?, ?, 1, NOW())',
    [login, hashPassword(senha), nome || null]
  );
  return { id_conta: r.insertId, login };
}

export async function verificarConta(login, senha) {
  const core = getCorePool();
  const [rows] = await core.query('SELECT id_conta, login, senha_hash, nome, ativo FROM contas WHERE login = ?', [login]);
  if (!rows.length) return null;
  const c = rows[0];
  if (!c.ativo) return null;
  if (!verifyPassword(senha, c.senha_hash)) return null;
  return { id_conta: c.id_conta, login: c.login, nome: c.nome };
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
  // 1) conta da empresa (tenant root) — tambem usada por sistemas externos
  const [rows] = await core.query(
    'SELECT id_cliente, login, senha_hash, schema_name, nome_empresa, ativo FROM clientes WHERE login = ?',
    [login]
  );
  if (rows.length) {
    const c = rows[0];
    if (c.ativo && verifyPassword(senha, c.senha_hash))
      return { id_cliente: c.id_cliente, schema_name: c.schema_name, login: c.login,
        nome_empresa: c.nome_empresa, tipo: 'empresa' };
  }
  // 2) operador (usuario do tenant) — so para login web (JWT)
  const [ops] = await core.query(
    'SELECT id_usuario, id_cliente, schema_name, login, senha_hash, nome, nivel, ativo FROM usuarios WHERE login = ?',
    [login]
  );
  if (ops.length) {
    const u = ops[0];
    if (u.ativo && verifyPassword(senha, u.senha_hash))
      return { id_cliente: u.id_cliente, schema_name: u.schema_name, login: u.login,
        nome: u.nome, tipo: 'operador', nivel: u.nivel };
  }
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
