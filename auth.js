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
    // "numero do banco" que sistemas externos (Secullum) usam:
    database: c.schema_name,
  };
}

// Middleware: resolve o tenant e anexa req.tenant + req.db (pool do schema).
export async function authTenant(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    let id_cliente, schema, login;

    if (auth.startsWith('Bearer ')) {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      id_cliente = payload.id_cliente;
      schema = payload.schema;
      login = payload.login;
    } else if (auth.startsWith('Basic ')) {
      // Estilo iDCloud: usuario:senha + X-Client-DB (numero do banco)
      const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      const db = req.headers['x-client-db'];
      const c = verificarCredenciais(u, p);
      if (!c || c.schema_name !== db) {
        return res.status(403).json({ error: 'Credenciais ou banco invalidos' });
      }
      id_cliente = c.id_cliente;
      schema = c.schema_name;
      login = u;
    } else {
      return res.status(401).json({ error: 'Nao autenticado' });
    }

    req.tenant = { id_cliente, schema, login };
    req.db = getTenantPool(schema);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

// Protege a criacao de clientes (setup). Use IZCLOUD_ADMIN_KEY no header.
export function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

export { getCorePool };
