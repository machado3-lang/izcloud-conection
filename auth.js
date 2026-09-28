// auth.js — Autenticacao do iZCloud
// Perfis de acesso:
//   1) Web (Bearer JWT):
//      - conta   (izcloud_core.contas) -> uma ou varias empresas; a empresa ativa
//        vem do header `X-Empresa: <schema>`.
//      - operador (izcloud_core.usuarios) -> empresa unica, embutida no token.
//   2) Sistemas externos (ex.: Secullum), estilo iDCloud:
//      Basic (login:senha da EMPRESA) + `X-Client-DB: <schema>`.
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getCorePool, getTenantPool, verificarCredenciais, verificarConta, listarEmpresas, registrarLogin } from './core.js';

const JWT_SECRET = process.env.JWT_SECRET || '';
const ADMIN_KEY = process.env.IZCLOUD_ADMIN_KEY || '';
const JWT_ISS = 'izcloud';
const JWT_TTL = process.env.JWT_TTL || '12h';

// Segredos usados nos exemplos do README / defaults antigos. Em producao sao
// publicos: com eles, qualquer um forja token de admin e assina JWT.
const SEGREDOS_DE_EXEMPLO = [
  'trocavel_em_producao',
  'gere_um_segredo_forte',
  'chave_de_setup_inicial',
  'senha_forte_aqui',
];
function segredoInvalido(v, min) {
  return !v || v.length < min || SEGREDOS_DE_EXEMPLO.includes(v);
}
if (segredoInvalido(JWT_SECRET, 32)) {
  console.error('[auth] CRITICO: JWT_SECRET ausente, curto (<32) ou igual ao exemplo do README. Qualquer um pode forjar tokens. Gere com: openssl rand -hex 32');
}
if (segredoInvalido(ADMIN_KEY, 24)) {
  console.error('[auth] CRITICO: IZCLOUD_ADMIN_KEY ausente, curta (<24) ou igual ao exemplo do README. Gere com: openssl rand -hex 32');
}

// ---- Validacao de entrada ----
export function validarLogin(login) {
  if (typeof login !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(login)) {
    throw new Error('Login invalido: use de 3 a 64 caracteres (letras, numeros, ponto, _ ou -)');
  }
  return login;
}

export function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < 8) throw new Error('Senha deve ter no minimo 8 caracteres');
  if (senha.length > 200) throw new Error('Senha muito longa (maximo 200 caracteres)');
  return senha;
}

// ---- Limitador de tentativas (em memoria; por processo) ----
//
// REGRA: conta FALHA, nao tentativa. Um login que da certo tem de zerar a
// contagem — senao um usuario que acerta a senha 8 vezes em 15 min (testando,
// abrindo em outra aba, trocando de conta) fica trancado do mesmo jeito que um
// atacante.
//
//   limiteTentativas(p)  -> middleware que SÓ barra (nao consome)
//   registrarFalha(req)  -> a rota chama quando a autenticacao falha
//   limparFalhas(req)    -> a rota chama quando da certo
//
// O middleware nao pode consumir: ele roda ANTES da rota e nao sabe o resultado.
const LIMITE = Number(process.env.IZCLOUD_LOGIN_MAX_TENTATIVAS || 10);
const JANELA_MS = Number(process.env.IZCLOUD_LOGIN_JANELA_MS || 15 * 60 * 1000);
const MAX_CHAVES = 20000;
const _falhas = new Map();

const chaveDe = (prefixo, req) => `${prefixo}:${req.ip || 'desconhecido'}`;

// Consulta sem efeito colateral. { bloqueado, retryAfter, restantes }
export function consultarFalhas(chave) {
  const r = _falhas.get(chave);
  if (!r || Date.now() > r.ate) return { bloqueado: false, retryAfter: 0, restantes: LIMITE };
  const n = r.n;
  return {
    bloqueado: n >= LIMITE,
    retryAfter: Math.ceil((r.ate - Date.now()) / 1000),
    restantes: Math.max(0, LIMITE - n),
  };
}

export function registrarFalha(chave) {
  const agora = Date.now();
  if (_falhas.size >= MAX_CHAVES) {
    for (const [k, v] of _falhas) if (agora > v.ate) _falhas.delete(k);
    if (_falhas.size >= MAX_CHAVES) _falhas.clear();
  }
  const r = _falhas.get(chave);
  if (!r || agora > r.ate) _falhas.set(chave, { n: 1, ate: agora + JANELA_MS });
  else r.n = Math.min(r.n + 1, LIMITE + 1);
  return consultarFalhas(chave);
}

export function limparFalhas(chave) {
  if (chave) _falhas.delete(chave);
}

// Atalho usado nos testes e em rotas que nao recebem `req`.
export function consumirTentativa(chave) {
  return registrarFalha(chave);
}

setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of _falhas) if (agora > v.ate) _falhas.delete(k);
}, 60000).unref();

// Middleware: barra se ja ha falhas demais. NAO consome slot — quem consome e
// `registrarFalha`, chamado pela rota so quando a autenticacao falha mesmo.
export function limiteTentativas(prefixo, rotulo = 'login') {
  return (req, res, next) => {
    const chave = chaveDe(prefixo, req);
    const st = consultarFalhas(chave);
    if (st.bloqueado) {
      res.setHeader('Retry-After', String(st.retryAfter));
      const minutos = Math.max(1, Math.ceil(st.retryAfter / 60));
      return res.status(429).json({
        error: `Muitas tentativas de ${rotulo} sem sucesso. Tente novamente em ${minutos} min.`,
        retryAfter: st.retryAfter,
      });
    }
    res.locals.chaveFalha = chave;
    next();
  };
}

// ---- Login WEB ----
export async function login(loginU, senha) {
  validarLogin(loginU);
  if (typeof senha !== 'string' || senha === '') throw new Error('Credenciais invalidas');

  // 1) conta do cliente (pode ter varias empresas)
  const c = await verificarConta(loginU, senha);
  if (c) {
    const empresas = await listarEmpresas(c.id_conta);
    const token = jwt.sign({ tipo: 'conta', id_conta: c.id_conta }, JWT_SECRET, {
      expiresIn: JWT_TTL, issuer: JWT_ISS, subject: String(c.id_conta),
    });
    registrarLogin(c.id_conta);
    return { token, contas: empresas, nome: c.nome, perfil: { tipo: 'conta', papel: c.papel } };
  }

  // 2) operador de uma empresa. A credencial da EMPRESA (clientes.login) nao
  //    entra no login web de proposito: ela e a credencial de API externa.
  const o = await verificarCredenciais(loginU, senha);
  if (o && o.tipo === 'operador') {
    const token = jwt.sign(
      { tipo: 'operador', id_usuario: o.id_usuario, id_cliente: o.id_cliente, schema: o.schema_name, nivel: o.nivel },
      JWT_SECRET,
      { expiresIn: JWT_TTL, issuer: JWT_ISS, subject: String(o.id_usuario) }
    );
    return {
      token,
      contas: [{ id_cliente: o.id_cliente, schema: o.schema_name, nome_empresa: o.nome_empresa || null, login: o.login }],
      nome: o.nome,
      perfil: { tipo: 'operador', nivel: o.nivel },
    };
  }

  throw new Error('Credenciais invalidas');
}

// Confere se o operador do token continua ativo (e a empresa tambem).
async function resolverOperador(payload) {
  const core = getCorePool();
  const [rows] = await core.query(
    'SELECT u.id_usuario, u.id_cliente, u.schema_name, u.login, u.nivel, u.ativo, c.ativo AS empresa_ativa ' +
    'FROM usuarios u JOIN clientes c ON c.id_cliente = u.id_cliente WHERE u.id_usuario = ?',
    [Number(payload.id_usuario)]
  );
  if (!rows.length) return null;
  const u = rows[0];
  if (!u.ativo || !u.empresa_ativa) return null;
  return u;
}

// Middleware: exige JWT de CONTA com papel 'admin' (administrador da
// plataforma). O papel NAO vem do token — e lido do banco a cada requisicao,
// para que rebaixar/desativar um admin tenha efeito imediato.
export async function authAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Nao autenticado' });
    const payload = jwt.verify(auth.slice(7), JWT_SECRET, { issuer: JWT_ISS, algorithms: ['HS256'] });
    if (payload.tipo !== 'conta' || !payload.id_conta) return res.status(403).json({ error: 'Acesso negado' });

    const core = getCorePool();
    const [rows] = await core.query(
      "SELECT id_conta, login, nome, papel, ativo FROM contas WHERE id_conta = ?", [payload.id_conta]
    );
    if (!rows.length) return res.status(403).json({ error: 'Conta nao encontrada' });
    const c = rows[0];
    if (!c.ativo) return res.status(403).json({ error: 'Conta desativada' });
    if (c.papel !== 'admin') return res.status(403).json({ error: 'Somente administradores da plataforma' });

    req.admin = { id_conta: c.id_conta, login: c.login, nome: c.nome };
    next();
  } catch {
    if (!res.headersSent) res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

// Middleware: valida apenas o JWT de CONTA (sem exigir empresa selecionada).
// Usado por GET/POST/PUT /api/empresas.
export async function authConta(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Nao autenticado' });
    const payload = jwt.verify(auth.slice(7), JWT_SECRET, { issuer: JWT_ISS, algorithms: ['HS256'] });
    if (payload.tipo !== 'conta' || !payload.id_conta) return res.status(403).json({ error: 'Acesso negado' });
    req.conta = { id_conta: payload.id_conta };
    next();
  } catch {
    res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

// Middleware: resolve o tenant da EMPRESA ATIVA e anexa req.tenant + req.db.
export async function authTenant(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    let id_conta, schema, login, tipo, nivel, empresa_id;

    if (auth.startsWith('Bearer ')) {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET, { issuer: JWT_ISS, algorithms: ['HS256'] });

      if (payload.tipo === 'operador') {
        const u = await resolverOperador(payload);
        if (!u) return res.status(403).json({ error: 'Usuario desativado ou inexistente' });
        id_conta = null; schema = u.schema_name; empresa_id = u.id_cliente;
        login = u.login; tipo = 'operador'; nivel = u.nivel;
      } else if (payload.tipo === 'conta') {
        if (!payload.id_conta) return res.status(403).json({ error: 'Acesso negado' });
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
        tipo = 'conta'; nivel = 'admin';
      } else {
        return res.status(403).json({ error: 'Acesso negado' });
      }
    } else if (auth.startsWith('Basic ')) {
      // Estilo iDCloud: usuario:senha + X-Client-DB (numero do banco).
      // Sistemas externos (Secullum) usam SO a conta da empresa, nunca operadores.
      const db = req.headers['x-client-db'];
      if (!db || typeof db !== 'string' || !/^tenant_\d{1,10}$/.test(db)) {
        return res.status(400).json({ error: 'Header X-Client-DB (numero do banco) e obrigatorio' });
      }
      const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      const c = await verificarCredenciais(u, p);
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
      tipo = 'empresa'; nivel = 'operador';
    } else {
      return res.status(401).json({ error: 'Nao autenticado' });
    }

    req.tenant = { id_conta, empresa_id, schema, login, tipo, nivel };
    req.db = getTenantPool(schema);
    next();
  } catch (e) {
    if (!res.headersSent) res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

// So a conta (dono) ou um operador admin podem gerenciar usuarios da empresa.
export function requireTenantAdmin(req, res, next) {
  const t = req.tenant;
  if (t && (t.tipo === 'conta' || t.nivel === 'admin')) return next();
  return res.status(403).json({ error: 'Apenas admin da empresa pode gerenciar usuarios' });
}

// Protege rotas de setup/administracao. Use IZCLOUD_ADMIN_KEY no header
// `x-admin-key`. A comparacao e em tempo constante. As rotas devem vir
// acompanhadas de `limiteTentativas('adminkey')` — aqui so registramos a falha.
export function requireAdmin(req, res, next) {
  const enviada = req.headers['x-admin-key'];
  const a = Buffer.from(String(enviada || ''));
  const b = Buffer.from(ADMIN_KEY || '');
  const ok = ADMIN_KEY && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    if (res.locals.chaveFalha) registrarFalha(res.locals.chaveFalha);
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Versao ja com limite aplicado, para nao esquecer a ordem.
const limiteAdminKey = limiteTentativas('adminkey', 'chave de setup');
export function adminKey(req, res, next) {
  return limiteAdminKey(req, res, () => requireAdmin(req, res, next));
}

export { getCorePool };
