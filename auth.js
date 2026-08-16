// auth.js — Autenticacao multi-tenant do iZCloud
// Dois modos de acesso (estilo iDCloud da ControlID):
//   1) Web: POST /api/auth/login -> JWT (Bearer)
//   2) Sistema externo (ex.: Secullum): Basic Auth (usuario:senha) + header
//      X-Client-DB: <schema>  ("numero do banco" do cliente)
import jwt from 'jsonwebtoken';
import { getCorePool, getTenantPool, verificarCredenciais } from './core.js';

const JWT_SECRET = process.env.JWT_SECRET || 'trocavel_em_producao';
const ADMIN_KEY = process.env.IZCLOUD_ADMIN_KEY || '';

export function login(login, senha) {
  const c = verificarCredenciais(login, senha);
  if (!c) throw new Error('Credenciais invalidas');
  const token = jwt.sign(
    { id_cliente: c.id_cliente, schema: c.schema_name, login: c.login },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  return {
    token,
    schema: c.schema_name,
    login: c.login,
    nome_empresa: c.nome_empresa,
    // multi-usuario: distingue conta da empresa de operador do tenant
    tipo: c.tipo,            // 'empresa' | 'operador'
    nivel: c.nivel || null,  // 'admin' | 'operador' (so p/ operador)
    // "numero do banco" que sistemas externos (Secullum) usam:
    database: c.schema_name,
  };
}

// Middleware: resolve o tenant e anexa req.tenant + req.db (pool do schema).
export async function authTenant(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    let id_cliente, schema, login, tipo, nivel;

    if (auth.startsWith('Bearer ')) {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      id_cliente = payload.id_cliente;
      schema = payload.schema;
      login = payload.login;
      tipo = payload.tipo;
      nivel = payload.nivel;
    } else if (auth.startsWith('Basic ')) {
      // Estilo iDCloud: usuario:senha + X-Client-DB (numero do banco).
      // Sistemas externos (Secullum) usam SO a conta da empresa, nunca operadores.
      const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      const db = req.headers['x-client-db'];
      const c = verificarCredenciais(u, p);
      if (!c || c.schema_name !== db) {
        return res.status(403).json({ error: 'Credenciais ou banco invalidos' });
      }
      if (c.tipo !== 'empresa') {
        return res.status(403).json({ error: 'Acesso de sistema externo exige conta de empresa' });
      }
      id_cliente = c.id_cliente;
      schema = c.schema_name;
      login = u;
      tipo = c.tipo;
      nivel = c.nivel || null;
    } else {
      return res.status(401).json({ error: 'Nao autenticado' });
    }

    req.tenant = { id_cliente, schema, login, tipo, nivel };
    req.db = getTenantPool(schema);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

// So a conta da empresa (tipo='empresa') ou um operador admin podem gerenciar usuarios.
export function requireTenantAdmin(req, res, next) {
  const t = req.tenant;
  if (t && (t.tipo === 'empresa' || t.nivel === 'admin')) return next();
  return res.status(403).json({ error: 'Apenas admin da empresa pode gerenciar usuarios' });
}

// Protege a criacao de clientes (setup). Use IZCLOUD_ADMIN_KEY no header.
export function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

export { getCorePool };
