// auth.js — Autenticacao do iZCloud
// Dois perfis de acesso:
//   1) Web: POST /api/auth/login -> conta (contas). Um JWT de conta + lista de
//      empresas. Ao selecionar uma empresa, o front envia o header
//      `X-Empresa: <schema>` e o servidor opera sobre aquele tenant. Cada conta
//      so enxerga as suas empresas.
//   2) Sistema externo (ex.: Secullum): Basic (login:senha da EMPRESA) + header
//      `X-Client-DB: <schema>` (estilo iDCloud). Continua validando a empresa e
//      o "numero do banco".
import jwt from 'jsonwebtoken';
import { getCorePool, getTenantPool, verificarCredenciais, verificarConta, listarEmpresas } from './core.js';

const JWT_SECRET = process.env.JWT_SECRET || 'trocavel_em_producao';
const ADMIN_KEY = process.env.IZCLOUD_ADMIN_KEY || '';

// Login WEB: valida a CONTA e retorna o token + as empresas da conta.
export async function login(loginU, senha) {
  const c = verificarConta(loginU, senha);
  if (!c) throw new Error('Credenciais invalidas');
  const empresas = await listarEmpresas(c.id_conta);
  const token = jwt.sign({ id_conta: c.id_conta, tipo: 'conta' }, JWT_SECRET, { expiresIn: '12h' });
  return {
    token,
    contas: empresas, // [{id_cliente, schema, razao_social, nome_empresa, cnpj,...}]
    nome: c.nome,
  };
}

// Middleware: valida apenas o JWT de CONTA (sem exigir empresa selecionada).
// Usado por rotas de gerenciamento de empresas (GET/POST/PUT /api/empresas).
export async function authConta(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Nao autenticado' });
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.tipo !== 'conta') return res.status(403).json({ error: 'Acesso negado' });
    req.conta = { id_conta: payload.id_conta };
    next();
  } catch { res.status(401).json({ error: 'Token invalido ou expirado' }); }
}

// Middleware: resolve o tenant da EMPRESA ATIVA (X-Empresa) e anexa req.tenant + req.db.
export async function authTenant(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    let id_conta, schema, login, tipo, empresa_id;

    if (auth.startsWith('Bearer ')) {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      if (payload.tipo !== 'conta') return res.status(403).json({ error: 'Acesso negado' });
      const emp = req.headers['x-empresa'];
      if (!emp) return res.status(400).json({ error: 'Selecione uma empresa (header X-Empresa)' });
      const core = getCorePool();
      const [rows] = await core.query(
        'SELECT id_cliente, schema_name, razao_social, nome_empresa FROM clientes WHERE id_conta = ? AND schema_name = ? AND ativo = 1',
        [payload.id_conta, emp]
      );
      if (!rows.length) return res.status(403).json({ error: 'Empresa nao pertence a esta conta' });
      id_conta = payload.id_conta;
      schema = rows[0].schema_name;
      empresa_id = rows[0].id_cliente;
      login = rows[0].razao_social || rows[0].nome_empresa || schema;
      tipo = 'conta';
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
      id_conta = null;
      schema = c.schema_name;
      empresa_id = c.id_cliente;
      login = u;
      tipo = c.tipo;
    } else {
      return res.status(401).json({ error: 'Nao autenticado' });
    }

    req.tenant = { id_conta, empresa_id, schema, login, tipo };
    req.db = getTenantPool(schema);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

// So a conta (dono) ou um operador admin podem gerenciar usuarios da empresa.
export function requireTenantAdmin(req, res, next) {
  const t = req.tenant;
  if (t && (t.tipo === 'conta' || t.nivel === 'admin')) return next();
  return res.status(403).json({ error: 'Apenas admin da empresa pode gerenciar usuarios' });
}

// Protege a criacao de clientes (setup legado). Use IZCLOUD_ADMIN_KEY no header.
export function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

export { getCorePool };
