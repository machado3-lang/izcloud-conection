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
  };
}

let _core = null;
export function getCorePool() {
  if (!_core) {
    _core = mysql.createPool({
      ...cfg(),
      database: process.env.CORE_DB || 'izcloud_core',
      ssl: { rejectUnauthorized: false },
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return _core;
}

// Pool por tenant (cacheado). O "banco" do cliente e o schema.
const _tenants = new Map();
export function getTenantPool(schemaName) {
  if (!_tenants.has(schemaName)) {
    _tenants.set(schemaName, mysql.createPool({
      ...cfg(),
      database: schemaName,
      ssl: { rejectUnauthorized: false },
      waitForConnections: true,
      connectionLimit: 5,
    }));
  }
  return _tenants.get(schemaName);
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
export async function criarCliente({ login, senha, nome_empresa, cnpj }) {
  const core = getCorePool();
  const [ex] = await core.query('SELECT id_cliente FROM clientes WHERE login = ?', [login]);
  if (ex.length) throw new Error('Login ja existe');

  const [r] = await core.query(
    'INSERT INTO clientes (login, senha_hash, schema_name, nome_empresa, cnpj, ativo, criado_em) VALUES (?, ?, ?, ?, ?, 1, NOW())',
    [login, hashPassword(senha), '', nome_empresa || null, cnpj || null]
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
