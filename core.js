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
function hashPassword(senha) {
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
  const [rows] = await core.query(
    'SELECT id_cliente, login, senha_hash, schema_name, nome_empresa, ativo FROM clientes WHERE login = ?',
    [login]
  );
  if (!rows.length) return null;
  const c = rows[0];
  if (!c.ativo) return null;
  if (!verifyPassword(senha, c.senha_hash)) return null;
  return c;
}

export async function listarClientes() {
  const core = getCorePool();
  const [rows] = await core.query(
    'SELECT id_cliente, login, schema_name, nome_empresa, cnpj, ativo, criado_em FROM clientes ORDER BY id_cliente'
  );
  return rows;
}
