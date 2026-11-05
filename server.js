// server.js - API multi-tenant do iZCloud (nossa nuvem para REPs 1510/671)
import 'dotenv/config';
import express, { Router } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { probe, enviarUsuarios } from './repClient.js';
import { importarDoRep } from './importarRep.js';
import { IdCloudClient } from './idcloud.js';
import { gerarPorPeriodo } from './afd.js';
import { sincronizarAfd, coletarAfdRep, iniciarPoller } from './sync.js';
import { salvarArquivoAfd, listarArquivos, lerArquivoAfd } from './afdStore.js';
import * as idface from './idface.js';
import { getCorePool, getTenantPool, verificarConexaoCore, inicializarCore, criarCliente, listarClientes, criarUsuario, listarUsuarios, removerUsuario, criarConta, verificarConta, buscarConta, existeAdmin, listarEmpresas, criarEmpresa, atualizarEmpresa, listarContas, atualizarConta, resetarSenhaConta, listarTodasEmpresas, atualizarEmpresaAdmin, auditar, listarAuditoria, aplicarMigracoesTenant, gerarCredencialRep, listarCapturasRep, limparCapturasRep,
  estadoColetaRep, listarColetasRep, migrarTenantsExistentes } from './core.js';
import { login, authTenant, authConta, authAdmin, adminKey, requireAdmin, requireTenantAdmin, limiteTentativas, registrarFalha, limparFalhas, validarLogin, validarSenha } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AFD_DIR = path.join(__dirname, 'data', 'afd');
if (!fs.existsSync(AFD_DIR)) fs.mkdirSync(AFD_DIR, { recursive: true });

const app = express();

// A Railway/CDN proxeia o trafego: sem isso, req.ip seria sempre o IP do proxy
// e o limitador de tentativas trataria todo mundo como o mesmo cliente.
app.set('trust proxy', true);

// CORS: a UI e servida na mesma origem, entao nao ha necessidade de liberar
// nada. IZCLOUD_ORIGENS e para casos excepcionais (lista separada por virgula).
const ORIGENS = (process.env.IZCLOUD_ORIGENS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(ORIGENS.length ? { origin: ORIGENS, credentials: true } : { origin: false }));

// ---------- Canal iDCloud: captura bruta ----------
// Registrado ANTES do express.json, de propenso. Esta e a rota que o REP tenta
// chamar (o firmware tem o IP da nuvem gravado na config e o iDCloud ligado:
// get_idcloud -> {"enable":true}). Ainda nao sabemos o que ele manda nem em que
// porta, entao a rota responde 200 para QUALQUER coisa e guarda os bytes crus.
// Depois do express.json seria inutil: um corpo nao-JSON seria rejeitado com 400
// antes de alguem ver, e um handshake de MySQL/TLS nem chega a ser HTTP.
//
// Por que isso e' seguro: e' um coletor de leitura, nao cria nem altera nada. O
// que impede virar storage DoS e' o limite de tamanho e a rotacao de linhas.
const CAPTURA_LIMITE = 256 * 1024;      // 256 KB de corpo por captura
const CAPTURA_MAX_LINHAS = 500;          // e' o que fica no banco

// Precisa ser um Router: express.raw() devolve um MIDDLEWARE, nao um app
// (chamar .all() nele quebra na subida do processo).
const captura = Router();

// O express.raw fica NAS ROTAS, nao no Router. Com `type: () => true` montado
// globalmente ele consome o corpo de TODAS as requisicoes e o express.json
// depois ve um Buffer em vez de objeto - o login passava a receber
// "Login invalido" mesmo com credencial boa.
const corpoBruto = express.raw({ type: () => true, limit: '4mb' });

// Grava uma captura. Funcao unica porque o mesmo registro e' usado tanto pelas
// rotas conhecidas quanto pelo 404 das rotas desconhecidas.
async function gravarCaptura(req, corpo) {
  const hex = corpo.subarray(0, CAPTURA_LIMITE).toString('hex');
  const txt = corpo.subarray(0, CAPTURA_LIMITE).toString('latin1');
  try {
    const core = getCorePool();
    await core.query(
      `INSERT INTO capturas_rep (origem, metodo, caminho, cabecalhos, corpo_hex, corpo_txt, tam_bytes, corte, criado_em)
       VALUES (?,?,?,?,?,?,?,?,NOW())`,
      [String(req.ip || '').slice(0, 45), req.method, String(req.originalUrl || '').slice(0, 255),
        JSON.stringify(req.headers).slice(0, 60000), hex, txt, corpo.length, corpo.length > CAPTURA_LIMITE ? 1 : 0]);
    await core.query(
      `DELETE FROM capturas_rep WHERE id NOT IN
       (SELECT id FROM (SELECT id FROM capturas_rep ORDER BY id DESC LIMIT ${CAPTURA_MAX_LINHAS}) x)`);
    console.log(`[captura] ${req.method} ${req.originalUrl} de ${req.ip} - ${corpo.length} bytes`);
  } catch (e) {
    console.error('[captura] falha ao gravar:', e.message);
  }
}

captura.all('/push', async (req, res) => {
  await gravarCaptura(req, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  // Resposta tolerante: o aparelho espera JSON. "transactions" vazio porque e'
  // o formato que o push oficial usa para dizer "nada a fazer".
  res.status(200).json({ transactions: [] });
});

// Variantes que o aparelho pode estar chamando, todas com o mesmo coletor.
captura.all(['/api/push', '/api/push/poll', '/event', '/api/push/event', '/result', '/api/push/result'],
  corpoBruto, (req, res) => res.status(200).json({ transactions: [] }));

// Rede de seguranca: o caminho do canal iDCloud e' DESCONHECIDO. Se o REP chamar
// algo diferente de /push, um 404 sumiria com a tentativa e nao teriamos como
// descobrir o que era. Entao qualquer caminho desconhecido tambem e' gravado —
// no 404, la embaixo, com o corpo bruto que este middleware guardou.
//
// O express.raw NAO pode ser montado aqui como `app.use(corpoBruto, ...)`:
// ele e' global e, com `type: () => true`, consome o corpo de TODAS as
// requisicoes — o express.json depois ve um Buffer e o login passa a responder
// "Login invalido" com credencial boa. Por isso o caminho e' decidido ANTES de
// tocar no corpo.
const ehArquivoEstatico = (p) => /^\/[\w\-./]+\.(js|css|png|jpg|svg|ico|woff2?|ttf|map|json|txt|webmanifest)$/i.test(p);
const precisaDoCorpoBruto = (p) => !p.startsWith('/api/') && p !== '/api' && !ehArquivoEstatico(p);

app.use((req, res, next) => {
  if (!precisaDoCorpoBruto(req.path)) return next();
  corpoBruto(req, res, (e) => {
    if (e) return next(e);
    req.corpoBruto = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    next();
  });
});

app.use(captura);


// 50MB de JSON em rota publica e um DoS facil; 20MB sobra para import de AFD.
// (A captura do REP ja foi registrada acima, de proposito, antes deste parser.)
app.use(express.json({ limit: '20mb' }));

// Headers basicos de seguranca. Sem CSP porque a UI e um unico HTML com
// CSS/JS inline (ver public/index.html).
app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const PORT = process.env.PORT || 3100;

// Auto-cadastro publico. Desligado por padrao: quem cria conta e o admin
// (IZCLOUD_ADMIN_KEY / painel de administracao). Ver docs/ADMIN.md.
const SIGNUP_ABERTA = /^(1|true|sim)$/i.test(String(process.env.IZCLOUD_SIGNUP_ABERTA || 'false'));

app.get('/', (_, res) => {
  const index = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.json({
    service: 'iZCloud',
    status: 'ok',
    health: '/api/health',
    repo: 'https://github.com/machado3-lang/izcloud-conection',
  });
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', service: 'iZCloud', multiTenant: true }));

// Config publica consumida pela UI (ex.: esconder o formulario de cadastro).
// `tem_admin` responde so sim/nao: sem nenhum admin na plataforma, ninguem pode
// entrar em /admin.html e o operador precisa saber disso.
app.get('/api/config', async (_, res) => {
  res.json({ signup_aberta: SIGNUP_ABERTA, tem_admin: await existeAdmin() });
});

// Diagnostico de banco. Detalhes de conexao (host/porta) so para quem tem a
// IZCLOUD_ADMIN_KEY - o endpoint e publico, entao nao pode vazar a topologia
// interna da nuvem.
app.get('/api/health/db', adminKey, async (_, res) => {
  try { res.json(await verificarConexaoCore()); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// Mesmo diagnostico, versao publica e sem dados sensiveis. `faltando` lista as
// colunas obrigatorias que ainda nao existem no core - e o que explica um
// login respondendo 503.
app.get('/api/health/status', async (_, res) => {
  try {
    const d = await verificarConexaoCore();
    res.json({
      ok: d.ok, tabela_contas: d.tabela_contas, colunas_ok: d.colunas_ok,
      faltando: d.faltando, tabelas_faltando: d.tabelas_faltando, erro: d.erro,
    });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ---------- Autenticacao / Tenants ----------
// Criacao de conta. Desligada por padrao (IZCLOUD_SIGNUP_ABERTA=false): quem
// cria conta e o administrador da plataforma. Ver docs/ADMIN.md.
const cadastroLiberado = (req, res, next) => {
  if (SIGNUP_ABERTA) return next();
  return requireAdmin(req, res, next);
};

// Cria empresa para uma conta existente (setup legado; usa x-admin-key).
// Exige id_conta: empresa sem dono nao aparece na UI e ninguem consegue acessar.
app.post('/api/auth/register', adminKey, async (req, res) => {
  try {
    if (!req.body.id_conta) throw new Error('Informe id_conta da conta que sera a dona da empresa');
    const r = await criarCliente(req.body);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Lista clientes (admin)
app.get('/api/auth/clientes', adminKey, async (_, res) => {
  try { res.json(await listarClientes()); } catch (e) { res.status(502).json({ error: e.message }); }
});

// Login -> JWT (conta ou operador) + lista de empresas.
app.post('/api/auth/login', limiteTentativas('login', 'login'), async (req, res) => {
  const chave = res.locals.chaveFalha;
  try {
    const r = await login(req.body.login, req.body.senha);
    // Deu certo: zera a contagem de falhas. Sem isso, 8 logins BEM-SUCEDIDOS
    // em 15 min travavam o usuario com "Muitas tentativas".
    limparFalhas(chave);
    res.json(r);
  } catch (e) {
    // Erros de validacao de formato sao uteis ao usuario; erro de credencial
    // e sempre a mesma frase (nao revela se o login existe). Qualquer outra
    // coisa (MySQL fora, bug) e logada: sem isso, um erro interno chega ao
    // usuario como "senha errada" e nao ha como diagnosticar.
    if (/^(Login invalido|Senha deve|Senha muito|Credenciais invalidas)/.test(e.message)) {
      registrarFalha(chave); // so credencial errada conta como tentativa
      return res.status(401).json({ error: e.message });
    }
    console.error('[auth] erro inesperado no login:', detalheErro(e));
    res.status(503).json({ error: 'Servico indisponivel. Tente novamente.' });
  }
});

// Cria a CONTA do cliente e (opcionalmente) a 1a empresa.
// Fechado por padrao: exige IZCLOUD_SIGNUP_ABERTA=true ou x-admin-key.
app.post('/api/auth/registro', cadastroLiberado, limiteTentativas('registro', 'cadastro'), async (req, res) => {
  const chave = res.locals.chaveFalha;
  try {
    const { login: loginU, senha, nome, empresa } = req.body;
    if (!loginU || !senha) throw new Error('Informe login e senha');
    validarLogin(loginU);
    validarSenha(senha);
    const c = await criarConta({ login: loginU, senha, nome });
    if (empresa && empresa.login) {
      validarLogin(empresa.login);
      validarSenha(empresa.senha);
      await criarEmpresa({ id_conta: c.id_conta, ...empresa });
    }
    const r = await login(loginU, senha);
    limparFalhas(chave);
    res.json(r);
  } catch (e) {
    registrarFalha(chave);
    res.status(400).json({ error: e.message });
  }
});

// ---------- Empresas (escopo da CONTA) ----------
// Perfil do dono do token, lido do BANCO (nao do JWT e nao do localStorage):
// e a fonte da verdade para o front decidir o que mostrar. Sem isso, uma conta
// promovida a admin so apareceria como admin depois de um novo login.
app.get('/api/auth/eu', authConta, async (req, res) => {
  try {
    const c = await buscarConta(req.conta.id_conta);
    if (!c) return res.status(403).json({ error: 'Conta nao encontrada' });
    res.json({ ...c, perfil: { tipo: 'conta', papel: c.papel } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.use('/api/empresas', authConta);

app.get('/api/empresas', async (req, res) => {
  try { res.json(await listarEmpresas(req.conta.id_conta)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/empresas', async (req, res) => {
  try {
    validarLogin(req.body.login);
    validarSenha(req.body.senha);
    const r = await criarEmpresa({ id_conta: req.conta.id_conta, ...req.body });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Migra o schema do tenant para o contrato iDCloud (tabelas/indices que podem
// faltar em empresas criadas antes). Idempotente.
app.post('/api/empresas/migrar-contrato', async (req, res) => {
  try {
    const aplicadas = await aplicarMigracoesTenant(req.tenant.schema);
    res.json({ ok: true, schema: req.tenant.schema, aplicadas });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Cria/rotaciona o usuario MySQL que o REP usara para conectar direto no banco
// desta empresa (como no iDCloud oficial). Mostra a senha uma unica vez.
app.post('/api/empresas/credencial-rep', async (req, res) => {
  try {
    const r = await gerarCredencialRep(req.tenant.empresa_id, { usuario: req.body.usuario });
    await auditar({ id_conta: req.conta.id_conta, acao: 'credencial_rep_gerada', alvo: r.empresa, ip: req.ip });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/empresas/:id', async (req, res) => {
  try {
    await atualizarEmpresa(req.conta.id_conta, Number(req.params.id), req.body);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Cria (ou promove) a conta de administrador da plataforma. Caminho de
// recuperacao quando IZCLOUD_ADMIN_LOGIN/IZCLOUD_ADMIN_SENHA nao foram
// definidos na Railway: nao exige redeploy, so a IZCLOUD_ADMIN_KEY.
//
//   curl -X POST .../api/admin/bootstrap -H "x-admin-key: $IZCLOUD_ADMIN_KEY" \
//        -H "Content-Type: application/json" \
//        -d '{"login":"admin","senha":"<forte>","nome":"Antonio"}'
app.post('/api/admin/bootstrap', adminKey, async (req, res) => {
  try {
    const { login: loginU, senha, nome } = req.body;
    if (!loginU || !senha) throw new Error('Informe login e senha');
    validarLogin(loginU);
    validarSenha(senha);
    const core = getCorePool();
    const [ex] = await core.query('SELECT id_conta, papel FROM contas WHERE login = ?', [loginU]);
    let id_conta, acao;
    if (ex.length) {
      id_conta = ex[0].id_conta;
      await core.query("UPDATE contas SET papel = 'admin', ativo = 1 WHERE id_conta = ?", [id_conta]);
      // A senha TAMBEM e trocada: esta rota existe para recuperar o acesso, e
      // nao serviria de nada se so devolvesse "acesso negado" na senha nova.
      await resetarSenhaConta(id_conta, senha);
      if (nome) await core.query('UPDATE contas SET nome = ? WHERE id_conta = ?', [nome, id_conta]);
      acao = 'promovida';
    } else {
      const c = await criarConta({ login: loginU, senha, nome, papel: 'admin' });
      id_conta = c.id_conta;
      acao = 'criada';
    }
    await auditar({ id_conta, acao: 'admin_bootstrap', alvo: loginU, detalhes: `conta ${acao} como admin; senha redefinida`, ip: req.ip });
    console.log(`[bootstrap] conta admin "${loginU}" ${acao} via /api/admin/bootstrap (id ${id_conta})`);
    res.json({ ok: true, id_conta, login: loginU, papel: 'admin', acao, senha_redefinida: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// =====================================================================
// ADMINISTRACAO DA PLATAFORMA (/api/admin/*) - tela public/admin.html
// Equivale ao "criar as contas dos usuarios" do iDCloud: o admin cria o login
// e a senha de cada cliente, que depois administra as proprias empresas.
// Regra: nada e apagado, apenas desativado (preserva schemas e dados de ponto).
// =====================================================================
app.use('/api/admin', authAdmin);

const CAMPOS_EMPRESA = ['razao_social', 'nome_empresa', 'tipo_documento', 'cnpj', 'cei', 'endereco', 'responsavel_nome', 'responsavel_cpf'];
function camposEmpresa(body) {
  const out = {};
  for (const k of CAMPOS_EMPRESA) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

// Visao geral: contas + empresas + totais.
app.get('/api/admin/panorama', async (req, res) => {
  try {
    const [contas, empresas, auditoria] = await Promise.all([
      listarContas(), listarTodasEmpresas(), listarAuditoria(15),
    ]);
    res.json({
      contas,
      empresas,
      auditoria,
      totais: {
        contas: contas.length,
        contas_ativas: contas.filter((c) => c.ativo).length,
        empresas: empresas.length,
        empresas_ativas: empresas.filter((e) => e.ativo).length,
      },
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/admin/contas', async (_, res) => {
  try { res.json(await listarContas()); } catch (e) { res.status(502).json({ error: e.message }); }
});

// Cria a conta do cliente e, opcionalmente, as empresas (cada uma = 1 tenant).
app.post('/api/admin/contas', async (req, res) => {
  try {
    const { login: loginU, senha, nome, empresas } = req.body;
    if (!loginU || !senha) throw new Error('Informe login e senha do cliente');
    validarLogin(loginU);
    validarSenha(senha);
    const lista = Array.isArray(empresas) ? empresas : (empresas ? [empresas] : []);
    for (const e of lista) {
      if (!e.login || !e.senha) throw new Error('Cada empresa precisa de login e senha de API');
      validarLogin(e.login);
      validarSenha(e.senha);
    }
    const c = await criarConta({ login: loginU, senha, nome, papel: 'cliente', criado_por: req.admin.id_conta });
    const criadas = [];
    for (const e of lista) {
      try {
        criadas.push(await criarEmpresa({ id_conta: c.id_conta, ...e }));
      } catch (err) {
        // A conta ja existe: devolve o erro mas nao perde o que foi criado.
        auditar({ id_conta: req.admin.id_conta, acao: 'empresa_falhou', alvo: e.login, detalhes: err.message, ip: req.ip });
        throw new Error(`Conta "${loginU}" criada, mas a empresa "${e.login}" falhou: ${err.message}`);
      }
    }
    await auditar({
      id_conta: req.admin.id_conta, acao: 'conta_criada', alvo: loginU,
      detalhes: `empresas: ${criadas.map((x) => x.schema).join(', ') || 'nenhuma'}`, ip: req.ip,
    });
    res.json({ ok: true, id_conta: c.id_conta, login: loginU, empresas: criadas });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Editar nome / papel / ativo. Nunca apaga.
app.put('/api/admin/contas/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await atualizarConta(id, req.body, req.admin.id_conta);
    await auditar({
      id_conta: req.admin.id_conta, acao: 'conta_alterada', alvo: String(req.params.id),
      detalhes: JSON.stringify(req.body), ip: req.ip,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/contas/:id/senha', async (req, res) => {
  try {
    validarSenha(req.body.senha);
    await resetarSenhaConta(Number(req.params.id), req.body.senha);
    await auditar({
      id_conta: req.admin.id_conta, acao: 'senha_resetada', alvo: String(req.params.id), ip: req.ip,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/contas/:id/empresas', async (req, res) => {
  try {
    const todas = await listarTodasEmpresas();
    res.json(todas.filter((e) => e.id_conta === Number(req.params.id)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Adiciona uma empresa a uma conta existente.
app.post('/api/admin/contas/:id/empresas', async (req, res) => {
  try {
    const id_conta = Number(req.params.id);
    const contas = await listarContas();
    if (!contas.some((c) => c.id_conta === id_conta)) throw new Error('Conta nao encontrada');
    validarLogin(req.body.login);
    validarSenha(req.body.senha);
    const r = await criarEmpresa({ id_conta, ...req.body });
    await auditar({
      id_conta: req.admin.id_conta, acao: 'empresa_criada', alvo: req.body.login,
      detalhes: `conta ${id_conta} -> ${r.schema}`, ip: req.ip,
    });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Empresas (todas as contas) ----
app.get('/api/admin/empresas', async (_, res) => {
  try { res.json(await listarTodasEmpresas()); } catch (e) { res.status(502).json({ error: e.message }); }
});

app.put('/api/admin/empresas/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await atualizarEmpresaAdmin(id, { ...camposEmpresa(req.body), ...(req.body.ativo !== undefined ? { ativo: req.body.ativo } : {}) });
    await auditar({
      id_conta: req.admin.id_conta, acao: 'empresa_alterada', alvo: String(req.params.id),
      detalhes: JSON.stringify(req.body), ip: req.ip,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Auditoria ----
app.get('/api/admin/auditoria', async (req, res) => {
  try { res.json(await listarAuditoria(req.query.limite)); } catch (e) { res.status(502).json({ error: e.message }); }
});

// Capturas do canal iDCloud. `?corpo=1` traz hex e texto dos bytes crus - e' o
// que revela o protocolo quando o REP conseguir falar.
app.get('/api/admin/capturas', async (req, res) => {
  try {
    res.json(await listarCapturasRep(req.query.limite, req.query.corpo === '1' || req.query.corpo === 'true'));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.delete('/api/admin/capturas', async (req, res) => {
  try { await limparCapturasRep(); res.json({ ok: true }); } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Usuarios/operadores do tenant (multi-usuario por empresa) ----------
// Apenas a conta da empresa ou um operador admin pode gerenciar.
app.use('/api/auth/usuarios', authTenant, requireTenantAdmin);

app.get('/api/auth/usuarios', async (req, res) => {
  try { res.json(await listarUsuarios(req.tenant.id_cliente)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/auth/usuarios', async (req, res) => {
  try {
    validarLogin(req.body.login);
    validarSenha(req.body.senha);
    const r = await criarUsuario({
      id_cliente: req.tenant.id_cliente, schema_name: req.tenant.schema,
      login: req.body.login, senha: req.body.senha, nome: req.body.nome,
      nivel: req.body.nivel === 'admin' ? 'admin' : 'operador',
    });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/auth/usuarios/:id', async (req, res) => {
  try {
    await removerUsuario(req.tenant.id_cliente, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- iDFace: push publico (o equipamento so manda deviceId/uuid) ----------
// O token vai no path. A URL configurada no iDFace e' a BASE; o firmware
// acrescenta `/push` e `/result`. Recomendado: /api/idface/<schema>/<token>.
// Tambem aceitamos /api/idface/<token> (varre os tenants, com cache curto).
const _cacheTokenPush = new Map();

async function buscarDispositivoPorToken(token) {
  const agora = Date.now();
  const cache = _cacheTokenPush.get(token);
  if (cache && cache.ate > agora) return cache.valor;
  let achado = null;
  try {
    const core = getCorePool();
    const [clientes] = await core.query('SELECT schema_name FROM clientes WHERE ativo = 1');
    for (const c of clientes) {
      const pool = getTenantPool(c.schema_name);
      const d = await idface.buscarPorToken(pool, token);
      if (d) { achado = { schema: c.schema_name, pool, dispositivo: d }; break; }
    }
  } catch { /* banco fora: o push responde 401 e o aparelho tenta de novo */ }
  _cacheTokenPush.set(token, { ate: agora + 60000, valor: achado });
  return achado;
}

async function resolverDispositivoPush(req) {
  const { schema, token } = req.params;
  if (schema && /^tenant_\d{1,10}$/.test(schema)) {
    try {
      const pool = getTenantPool(schema);
      const d = await idface.buscarPorToken(pool, token);
      if (d) return { schema, pool, dispositivo: d };
    } catch { /* cai no fallback */ }
  }
  return buscarDispositivoPorToken(token);
}

app.get(['/api/idface/:schema/:token/push', '/api/idface/:token/push'], async (req, res) => {
  try {
    const alvo = await resolverDispositivoPush(req);
    if (!alvo) return res.status(401).json({ error: 'token invalido' });
    const { pool, dispositivo } = alvo;

    // deviceId e' estavel e pode ser gravado no primeiro poll. Se ja existe e
    // nao confere, recusa: evita um token vazado ser usado por outro aparelho.
    const deviceId = req.query.deviceId ? Number(req.query.deviceId) : null;
    if (dispositivo.device_id && deviceId && Number(dispositivo.device_id) !== deviceId) {
      return res.status(403).json({ error: 'deviceId nao confere com o token' });
    }
    if (!dispositivo.device_id && deviceId) {
      await pool.query('UPDATE idface_dispositivos SET device_id = ? WHERE id = ?', [deviceId, dispositivo.id]);
    }

    await idface.registrarPoll(pool, dispositivo, req.query.uuid);
    const cmd = await idface.proximoComando(pool, dispositivo.id);
    if (!cmd) return res.json({ transactions: [] });
    return res.json(idface.montarComando(cmd));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post(['/api/idface/:schema/:token/result', '/api/idface/:token/result'], async (req, res) => {
  try {
    const alvo = await resolverDispositivoPush(req);
    if (!alvo) return res.status(401).json({ error: 'token invalido' });
    const { schema, pool, dispositivo } = alvo;

    const endpoint = req.query.endpoint || req.body?.endpoint || '';
    const uuid = req.query.uuid || null;
    const itens = Array.isArray(req.body?.transactions_results)
      ? req.body.transactions_results : [req.body || {}];

    const resultados = [];
    for (const item of itens) {
      const ep = item.endpoint || endpoint || null;
      const erro = item.error || item.erro || null;
      const response = item.response ?? item.result ?? null;

      const comando = await idface.concluirComando(pool, dispositivo.id, ep, erro);
      // Alguns firmwares nao repetem o endpoint no /result: nesse caso usamos o
      // endpoint do comando que estava entregue.
      const epEfetivo = ep || comando?.endpoint || '';
      await idface.registrarResultado(pool, {
        idDispositivo: dispositivo.id, endpoint: epEfetivo, uuid, response, erro,
      });
      resultados.push(await idface.processarResultado(pool, {
        schema, dispositivo, comando, endpoint: epEfetivo, response, erro,
        salvarArquivo: (dados) => salvarArquivoAfd(pool, dados),
      }));
    }
    return res.json({ ok: true, resultados });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Todas as rotas abaixo exigem autenticacao e sao ESCOPADAS ao tenant do cliente.
// /api/painel e /api/coletas tinham ficado de fora: sem o middleware, req.db e
// req.tenant chegavam undefined e as duas rotas respondiam 502 em producao.
app.use('/api/reps', authTenant);
app.use('/api/pessoas', authTenant);
app.use('/api/afd', authTenant);
app.use('/api/idface', authTenant);
app.use('/api/painel', authTenant);
app.use('/api/coletas', authTenant);

// ---------- Coleta pelo canal iDCloud ----------
// A UI reserva a vaga do REP; quando o aparelho conecta na 443 da VPS, o
// idcloudServer coleta o AFD. Estas rotas sao o painel disso.
app.post('/api/reps/:id/reservar-coleta', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('REP invalido');
    // O canal iDCloud precisa saber A QUAL empresa o REP pertence e qual e' o
    // serial dele. A vaga antiga so guardava o id: a coleta acabava tentando
    // gravar num banco chamado pelo serial. Agora a vaga carrega o tenant.
    const [rows] = await req.db.query(
      'SELECT id_Equipamento, COALESCE(Serial, CAST(id_Equipamento AS CHAR)) AS Serial, Passcode ' +
      'FROM equipamentos WHERE id_Equipamento = ?', [id]
    );
    if (!rows.length) throw new Error('REP nao encontrado nesta empresa');
    const min = Math.min(Math.max(Number(req.body?.minutos) || 30, 1), 240);
    const { reservarVaga } = await import('./idcloudServer.js');
    const ate = reservarVaga(id, min, {
      schema: req.tenant.schema,
      serial: rows[0].Serial,
      passcode: rows[0].Passcode,
    });
    res.json({
      ok: true, id_reps: id, serial: rows[0].Serial, schema: req.tenant.schema,
      reservado_ate: new Date(ate).toISOString(),
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/reps/:id/coleta', async (req, res) => {
  try { res.json(await estadoColetaRep(req.tenant.schema, req.params.id) || { id_reps: Number(req.params.id), coletas: 0 }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/coletas', async (req, res) => {
  try { res.json(await listarColetasRep(req.tenant.schema, req.query.limite)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- REPs (escopo do tenant) ----------
app.post('/api/reps/probe', async (req, res) => {
  try { res.json(await probe(req.body.ip, req.body.porta || 443, req.body.usuario, req.body.senha)); }
  catch (e) { res.status(502).json({ error: 'Falha ao sondar REP', detalhe: e.message }); }
});

app.post('/api/reps', async (req, res) => {
  try {
    const { id_Equipamento, Serial, serial, Nome, IpAddress, Porta, Passcode, REPType, ModoConexao } = req.body;
    // No contrato iDCloud o REP se reconhece lendo `equipamentos` e casando
    // id_Equipamento com a propria identidade. Logo o id tem que ser o que o
    // APARELHO reportou no get_about (nSerie), nunca um numero escolhido na tela.
    // Se o front mandou `serial`, ele manda no id.
    const serialTexto = String(serial || Serial || '').trim();
    const idDoAparelho = serialTexto ? Number(serialTexto) : null;
    const id = idDoAparelho !== null && !Number.isNaN(idDoAparelho)
      ? idDoAparelho
      : Number(id_Equipamento);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Informe o numero de serie do REP (o que o Sondar devolve)');

    const client = new IdCloudClient(req.db);
    await client.pool.query(
      `INSERT INTO equipamentos
       (id_Equipamento, Serial, Nome, IpAddress, Porta, Passcode, REPType, ModoConexao, DataAtualizacao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE Serial=VALUES(Serial), Nome=VALUES(Nome), IpAddress=VALUES(IpAddress),
         Porta=VALUES(Porta), Passcode=VALUES(Passcode), REPType=VALUES(REPType), ModoConexao=VALUES(ModoConexao)`,
      [id, serialTexto || String(id), Nome, IpAddress, Porta, Passcode, REPType, ModoConexao || 'nuvem_puxa']
    );
    res.json({ ok: true, id_Equipamento: id, serial: serialTexto || String(id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Le empresa + funcionarios + biometria que JA ESTAO na memoria do REP e
// grava no tenant. E' o fluxo "ligou o REP, nao precisa cadastrar de novo".
// Usa o IP/porta/Passcode ja salvos no equipamento (nao precisa redigitar).
app.post('/api/reps/:id/importar', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('REP invalido');
    const [rows] = await req.db.query(
      'SELECT id_Equipamento, IpAddress, Porta, Passcode FROM equipamentos WHERE id_Equipamento = ?', [id]
    );
    if (!rows.length) throw new Error('REP nao encontrado nesta empresa');
    const r = rows[0];
    if (!r.IpAddress) throw new Error('REP sem IP cadastrado');
    const client = new IdCloudClient(req.db);
    const out = await importarDoRep({
      client,
      idEquipamento: id,
      ip: r.IpAddress,
      porta: r.Porta || 443,
      usuario: 'admin',
      senha: r.Passcode || process.env.REP_ADMIN_SENHA || 'admin',
    });
    // Preenche o perfil da empresa apenas se estiver vazio: o cliente pode ter
    // um nome/CNPJ comercial diferente do empregador gravado no REP.
    if (out.empresa) {
      try {
        // Tipo (CNPJ/CPF) so acompanha o documento se ele ainda estiver vazio.
        await getCorePool().query(
          `UPDATE clientes SET tipo_documento = ?
             WHERE id_cliente = ? AND (cnpj IS NULL OR cnpj = '')`,
          [out.empresa.tipo_documento || 'CNPJ', req.tenant.empresa_id]
        );
        await getCorePool().query(
          `UPDATE clientes SET
             razao_social = COALESCE(NULLIF(razao_social, ''), ?),
             cnpj = COALESCE(NULLIF(cnpj, ''), ?),
             cei = COALESCE(NULLIF(cei, ''), ?),
             endereco = COALESCE(NULLIF(endereco, ''), ?)
           WHERE id_cliente = ?`,
          [out.empresa.RazaoSocial, out.empresa.CNPJ_CPF, out.empresa.CEI, out.empresa.Local, req.tenant.empresa_id]
        );
      } catch (e) {
        // Perfil e' cosmetico: a importacao do tenant ja deu certo.
        console.error('[importar] perfil da empresa nao atualizado:', e.message);
      }
    }
    res.json({ ok: true, idEquipamento: id, ...out });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/reps', async (req, res) => {
  try { res.json(await new IdCloudClient(req.db).listarEquipamentos()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Vinculos pessoa<->REP (subset de funcionarios por equipamento)
app.get('/api/reps/:id/funcionarios', async (req, res) => {
  try { res.json(await new IdCloudClient(req.db).listarVinculos(Number(req.params.id))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.put('/api/reps/:id/funcionarios', async (req, res) => {
  try {
    await new IdCloudClient(req.db).definirVinculos(Number(req.params.id), req.body.ids);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Pessoas (escopo do tenant) ----------
app.get('/api/pessoas', async (req, res) => {
  try { res.json(await new IdCloudClient(req.db).listarPessoas()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Todos os vinculos pessoa<->equipamento do tenant
app.get('/api/pessoas/vinculos', async (req, res) => {
  try { res.json(await new IdCloudClient(req.db).listarTodosVinculos()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Contagem de biometria (digitais/faces) por pessoa
app.get('/api/pessoas/biometria', async (req, res) => {
  try { res.json(await new IdCloudClient(req.db).contarBio()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Painel de visualizacao: cards + serie diaria + status por REP.
// ?dias=30 (7..180) define a janela do grafico.
app.get('/api/painel', async (req, res) => {
  try { res.json(await new IdCloudClient(req.db).painel(req.query.dias)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Importar empresa + funcionarios + biometria da memoria do REP para o iZCloud.
// Esta rota e' a versao "explicita" (recebe IP/senha no corpo). A UI usa
// /api/reps/:id/importar, que reaproveita o cadastro do equipamento.
app.post('/api/pessoas/importar', async (req, res) => {
  try {
    const { rep, idEquipamento } = req.body;
    if (!rep?.ip) throw new Error('Informe o IP do REP');
    if (!idEquipamento) throw new Error('Informe o id do equipamento');
    const client = new IdCloudClient(req.db);
    const out = await importarDoRep({
      client, idEquipamento: Number(idEquipamento),
      ip: rep.ip, porta: rep.porta || 443,
      usuario: rep.usuario || 'admin',
      senha: rep.senha || process.env.REP_ADMIN_SENHA || 'admin',
    });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Enviar ao REP apenas os funcionarios VINCULADOS a ele (filtrado por equip_pessoa) + biometria
app.post('/api/pessoas/sincronizar', async (req, res) => {
  try {
    const { rep = {}, idEquipamento } = req.body;
    const client = new IdCloudClient(req.db);
    // O IP/senha podem vir no corpo (API) ou ser lidos do equipamento ja
    // cadastrado (UI). A UI nao precisa redigitar a conexao a cada envio.
    let ip = rep.ip, porta = rep.porta, usuario = rep.usuario, senha = rep.senha;
    if ((!ip || !porta) && idEquipamento) {
      const [eq] = await client.pool.query(
        'SELECT IpAddress, Porta, Passcode FROM equipamentos WHERE id_Equipamento = ?', [idEquipamento]
      );
      if (eq.length) {
        ip = ip || eq[0].IpAddress;
        porta = porta || eq[0].Porta;
        senha = senha || eq[0].Passcode;
      }
    }
    if (!ip) throw new Error('REP sem IP cadastrado');
    const [vin] = await client.pool.query('SELECT id_Pessoa FROM equip_pessoa WHERE id_Equipamento = ?', [idEquipamento]);
    const users = [];
    for (const { id_Pessoa } of vin) {
      const [p] = await client.pool.query('SELECT id_pessoa, PIS, CPF, Nome, Codigo, Senha, Matricula FROM pessoas WHERE id_pessoa = ?', [id_Pessoa]);
      if (!p.length) continue;
      const pes = p[0];
      const u = {
        pis: pes.PIS, cpf: pes.CPF, name: pes.Nome,
        registration: pes.Matricula || pes.Codigo || 0, code: pes.Codigo || 0,
        password: pes.Senha || '1234',
      };
      const [tpl] = await client.pool.query('SELECT tipo, indice, dados FROM templates WHERE id_pessoa = ?', [id_Pessoa]);
      u.templates = tpl.filter(t => t.tipo === 'digital').map(t => ({ finger: t.indice, template: t.dados }));
      u.facial = tpl.filter(t => t.tipo === 'face').map(t => ({ faceTemplate: t.dados }));
      users.push(u);
    }
    const portaria = users.some(u => u.cpf) ? '671' : '1510';
    const r = await enviarUsuarios(ip, porta || 443, users, portaria,
      usuario || 'admin', senha || process.env.REP_ADMIN_SENHA || 'admin');
    res.json({ ok: true, enviados: users.length, rep: r });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Cadastro do funcionario. A gravacao na nuvem vem PRIMEIRO: a nuvem nao pode
// depender de alcancar o REP para aceitar um cadastro (o REP do cliente costuma
// estar atras de NAT). O envio ao REP, quando pedido, e' uma segunda etapa.
app.post('/api/pessoas', async (req, res) => {
  try {
    const { rep = {}, pessoa, idEquipamento } = req.body;
    if (!pessoa) throw new Error('Informe os dados do funcionario');
    const client = new IdCloudClient(req.db);

    // Conexao: pode vir no corpo (API) ou ser lida do equipamento cadastrado.
    // A UI manda so o idEquipamento; o IP/porta/Passcode ja estao no REP.
    let ip = rep.ip, porta = rep.porta, usuario = rep.usuario, senha = rep.senha;
    let tipoRep = rep.portaria || null;
    if ((!ip || !porta) && idEquipamento) {
      const [eq] = await client.pool.query(
        'SELECT IpAddress, Porta, Passcode, REPType FROM equipamentos WHERE id_Equipamento = ?', [idEquipamento]
      );
      if (eq.length) {
        ip = ip || eq[0].IpAddress;
        porta = porta || eq[0].Porta;
        senha = senha || eq[0].Passcode;
        tipoRep = tipoRep || eq[0].REPType || null;
      }
    }

    const portaria = tipoRep || (pessoa.cpf ? '671' : '1510');
    const id = await client.gravarPessoa({ ...pessoa, portaria });
    if (idEquipamento) await client.vincularEquipamento(id, Number(idEquipamento));

    let enviado = null, erroEnvio = null;
    if (ip) {
      try {
        enviado = await enviarUsuarios(ip, porta || 443, [pessoa], portaria,
          usuario || 'admin', senha || process.env.REP_ADMIN_SENHA || 'admin');
      } catch (e) {
        // O cadastro ja esta salvo. Devolver erro aqui faria o operador tentar
        // de novo e duplicar; a UI avisa que o envio ficou pendente.
        erroEnvio = e.message;
      }
    }
    res.json({ idNuvem: id, enviado: !!enviado, erroEnvio, rep: enviado });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- AFD (escopo do tenant) ----------
// Recepcao de AFD via "push" (modo rep_empurra): um REP/gateway encaminha as
// linhas cruas para este endpoint. Idempotente via UNIQUE(id_Equipamento, NSR).
app.post('/api/afd/push', async (req, res) => {
  try {
    const { idEquipamento, linhas, texto } = req.body;
    const client = new IdCloudClient(req.db);
    const arr = Array.isArray(linhas)
      ? linhas.map(l => String(l).trim()).filter(Boolean)
      : String(texto || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    await client.salvarAfd(idEquipamento, arr);
    res.json({ ok: true, total: arr.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Sincronizacao incremental manual/trig (modo nuvem_puxa)
app.post('/api/afd/sync', async (req, res) => {
  try {
    const { rep, idEquipamento, mode } = req.body;
    const r = await sincronizarAfd({
      ip: rep.ip, porta: rep.porta || 443, usuario: rep.usuario, senha: rep.senha,
      idEquipamento, mode: mode || rep.portaria, client: new IdCloudClient(req.db),
    });
    res.json(r);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Export por periodo (baixavel pelo cliente ou por sistema externo)
app.post('/api/afd/export', async (req, res) => {
  try {
    const { idEquipamento, dataInicio, dataFim, serial, formato } = req.body;
    const client = new IdCloudClient(req.db);
    const rows = await client.lerAfd({ idEquipamento, dataInicio, dataFim });
    const empregador = await empregadorDoTenant(req, idEquipamento);
    const { texto, total } = gerarPorPeriodo({
      linhasCruas: rows.map(r => r.Dado).filter(Boolean),
      serial, dataInicio, dataFim, formato, empregador,
    });
    res.setHeader('Content-Type', 'text/plain; charset=iso-8859-1');
    res.setHeader('Content-Disposition', `attachment; filename="AFD_${idEquipamento}_${dataInicio || ''}_${dataFim || ''}.txt"`);
    res.send(texto);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Fetch para sistemas externos (ex.: Secullum): sincroniza e devolve as novas marcacoes
app.post('/api/afd/fetch', async (req, res) => {
  try {
    const { rep, idEquipamento, mode } = req.body;
    const client = new IdCloudClient(req.db);
    const sync = await sincronizarAfd({
      ip: rep.ip, porta: rep.porta || 443, usuario: rep.usuario, senha: rep.senha,
      idEquipamento, mode: mode || rep.portaria, client,
    });
    const rows = await client.lerAfd({ idEquipamento });
    const empregador = await empregadorDoTenant(req, idEquipamento);
    const { texto } = gerarPorPeriodo({
      linhasCruas: rows.map(r => r.Dado).filter(Boolean),
      serial: rep.serial, formato: mode, empregador,
    });
    res.json({ sincronizados: sync.inseridos, afd: texto });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Import manual de AFD vindo de outro sistema (ex.: Secullum manda o arquivo)
app.post('/api/afd/import', async (req, res) => {
  try {
    const { idEquipamento, texto } = req.body;
    const client = new IdCloudClient(req.db);
    const linhas = String(texto || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    await client.salvarAfd(idEquipamento, linhas);
    const [reps] = await req.db.query(
      'SELECT Serial, REPType FROM equipamentos WHERE id_Equipamento = ?', [Number(idEquipamento)]
    );
    const rep = reps[0] || {};
    const arquivo = await salvarArquivoAfd(req.db, {
      schema: req.tenant.schema,
      origem: 'import',
      formato: rep.REPType === '671' ? '671' : '595',
      serial: rep.Serial,
      idEquipamento: Number(idEquipamento),
      texto: linhas.join('\r\n'),
    });
    res.json({ total: linhas.length, arquivo });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- iDClass: coleta/provedor de AFD bruto ----------
// O REP-C gera o AFD; o iZCloud so coleta e guarda. "completo", "por NSR" e
// "por data" sao filtros passados ao proprio REP (get_afd), garantindo header,
// trailer e CRC originais. O arquivo fica em data/afd/<schema>/ e pode ser
// baixado por qualquer sistema externo autenticado (Basic + X-Client-DB).
function basePublica(req) {
  return (process.env.IZCLOUD_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function dataParaApi(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

// Empregador para o header do AFD 1510: prioriza o que o REP tem em memoria
// (`empregadores`); se o REP ainda nao tem, usa o perfil da empresa no core.
// Assim o "cadastrar empregador" do iZCloud aparece no AFD gerado.
async function empregadorDoTenant(req, idEquipamento) {
  try {
    const [emps] = await req.db.query(
      `SELECT e.* FROM empregadores e
         JOIN equipamentos q ON q.id_Empregador = e.id_Empregador
        WHERE q.id_Equipamento = ? LIMIT 1`, [Number(idEquipamento)]
    );
    if (emps.length) return emps[0];
  } catch { /* tenant antigo sem empregadores */ }
  if (!req.tenant?.empresa_id) return null;
  try {
    const [cs] = await getCorePool().query(
      `SELECT razao_social, nome_empresa, cnpj, tipo_documento, cei
         FROM clientes WHERE id_cliente = ?`, [req.tenant.empresa_id]
    );
    const c = cs[0];
    if (!c) return null;
    return {
      RazaoSocial: c.razao_social || c.nome_empresa,
      CNPJ_CPF: c.cnpj,
      CEI: c.cei,
      tipo_documento: c.tipo_documento,
    };
  } catch { return null; }
}

// Junta a coleta + o salvamento do arquivo. Usado pelo POST /coletar (JSON) e
// pelo GET /download (arquivo direto), para nao duplicar a regra de filtros.
async function coletarAfdTenant(req, { idEquipamento, modo = 'incremental', nsr, dataInicio, formato } = {}) {
  const id = Number(idEquipamento);
  if (!Number.isFinite(id)) throw new Error('idEquipamento invalido');
  const [reps] = await req.db.query(
    'SELECT * FROM equipamentos WHERE id_Equipamento = ?', [id]
  );
  if (!reps.length) {
    const e = new Error('equipamento nao encontrado'); e.status = 404; throw e;
  }
  const rep = reps[0];
  if (!rep.IpAddress) {
    const e = new Error('equipamento sem IpAddress'); e.status = 400; throw e;
  }

  const mode = String(formato || rep.REPType || '1510');
  const client = new IdCloudClient(req.db);
  const base = {
    ip: rep.IpAddress, porta: rep.Porta || 443,
    usuario: 'admin', senha: rep.Passcode || 'admin',
    idEquipamento: id, mode, client,
  };

  let r;
  if (modo === 'incremental') {
    const [st] = await req.db.query(
      'SELECT last_nsr FROM sync_status WHERE id_Equipamento = ?', [id]
    );
    const lastNsr = st?.[0]?.last_nsr || 0;
    r = await coletarAfdRep({
      ...base, initialNsr: lastNsr + 1, desdeNsr: lastNsr, atualizarCursor: true,
    });
  } else {
    if (modo === 'nsr' && !Number.isFinite(Number(nsr))) {
      const e = new Error('nsr invalido'); e.status = 400; throw e;
    }
    const data = modo === 'data' ? dataParaApi(dataInicio) : null;
    if (modo === 'data' && !data) {
      const e = new Error('dataInicio invalida (use YYYY-MM-DD)'); e.status = 400; throw e;
    }
    r = await coletarAfdRep({
      ...base,
      completo: modo === 'completo',
      initialNsr: modo === 'nsr' ? Number(nsr) : null,
      initialDate: data,
      desdeNsr: 0,
      atualizarCursor: false,
    });
  }

  const arquivo = await salvarArquivoAfd(req.db, {
    schema: req.tenant.schema,
    origem: 'idclass',
    formato: mode === '671' ? '671' : '595',
    serial: rep.Serial,
    idEquipamento: id,
    texto: r.texto,
    nsrInicial: modo === 'nsr' ? Number(nsr) : null,
    nsrFinal: r.maxNsr || null,
    dataInicio: modo === 'data' ? dataInicio : null,
  });
  return { r, arquivo, mode, rep };
}

app.post('/api/afd/coletar', async (req, res) => {
  try {
    const { r, arquivo } = await coletarAfdTenant(req, req.body || {});
    res.json({ ok: true, inseridos: r.inseridos, maxNsr: r.maxNsr, arquivo });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// Download direto do AFD do REP, com o filtro pedido. O arquivo tambem fica
// salvo e listado em /api/afd/arquivos (auditoria).
app.get('/api/afd/download', async (req, res) => {
  try {
    const { idEquipamento, modo = 'completo', nsr, dataInicio, formato } = req.query;
    const { r, mode } = await coletarAfdTenant(req, {
      idEquipamento, modo, nsr, dataInicio, formato,
    });
    const sufixo = modo === 'nsr' ? `_nsr${nsr}` : (modo === 'data' ? `_${dataInicio}` : '_completo');
    res.setHeader('Content-Type', 'text/plain; charset=iso-8859-1');
    res.setHeader('Content-Disposition', `attachment; filename="AFD_${idEquipamento}${sufixo}.txt"`);
    res.send(r.texto);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get('/api/afd/arquivos', async (req, res) => {
  try {
    const { idEquipamento, origem, limite } = req.query;
    const rows = await listarArquivos(req.db, {
      origem: origem || null,
      idEquipamento: idEquipamento ? Number(idEquipamento) : null, limite,
    });
    res.json(rows);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/afd/arquivos/:id/download', async (req, res) => {
  try {
    const row = await lerArquivoAfd(req.db, req.params.id);
    if (!row) return res.status(404).json({ error: 'arquivo nao encontrado' });
    if (row.conteudo == null) return res.status(410).json({ error: row.erro || 'arquivo indisponivel' });
    res.setHeader('Content-Type', 'text/plain; charset=iso-8859-1');
    res.setHeader('Content-Disposition', `attachment; filename="${row.nome || 'AFD'}.txt"`);
    res.send(row.conteudo);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- iDFace: administracao e leitura (escopo do tenant) ----------
// O push publico (por token) esta definido ANTES do authTenant. Estas rotas
// exigem o login do cliente (JWT ou Basic + X-Client-DB).
app.get('/api/idface/dispositivos', async (req, res) => {
  try { res.json(await idface.listarDispositivos(req.db)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/idface/dispositivos', async (req, res) => {
  try {
    const disp = await idface.criarDispositivo(req.db, req.body || {});
    _cacheTokenPush.clear();
    const base = `${basePublica(req)}/api/idface/${req.tenant.schema}/${disp.token}`;
    res.status(201).json({ ...disp, push_base: base, push_url: `${base}/push` });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.put('/api/idface/dispositivos/:id', async (req, res) => {
  try {
    const disp = await idface.atualizarDispositivo(req.db, req.params.id, req.body || {});
    if (!disp) return res.status(404).json({ error: 'dispositivo nao encontrado' });
    _cacheTokenPush.clear();
    res.json(disp);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.delete('/api/idface/dispositivos/:id', async (req, res) => {
  try {
    await idface.atualizarDispositivo(req.db, req.params.id, { ativo: 0 });
    _cacheTokenPush.clear();
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Enfileira um comando. O equipamento executa no proximo poll.
app.post('/api/idface/dispositivos/:id/coletar', async (req, res) => {
  try {
    const disp = await idface.buscarDispositivo(req.db, req.params.id);
    if (!disp) return res.status(404).json({ error: 'dispositivo nao encontrado' });

    const { tipo = 'afd', formato = disp.portaria, modo = 'completo', nsr, dataInicio } = req.body || {};
    const comandos = [];

    if (tipo === 'logs') {
      comandos.push(await idface.enfileirarComando(req.db, disp.id, {
        endpoint: 'load_objects',
        body: { object: 'access_logs', limit: 1000, offset: 0 },
      }));
    } else if (tipo === 'usuarios') {
      comandos.push(await idface.enfileirarComando(req.db, disp.id, {
        endpoint: 'load_objects',
        body: { object: 'users', limit: 1000, offset: 0 },
      }));
      comandos.push(await idface.enfileirarComando(req.db, disp.id, {
        endpoint: 'load_objects',
        body: { object: 'c_users', limit: 1000, offset: 0 },
      }));
    } else {
      const body = {};
      if (modo === 'nsr') {
        if (!Number.isFinite(Number(nsr))) {
          return res.status(400).json({ error: 'nsr invalido' });
        }
        body.initial_nsr = Number(nsr);
      }
      if (modo === 'data') {
        const data = dataParaApi(dataInicio);
        if (!data) return res.status(400).json({ error: 'dataInicio invalida (use YYYY-MM-DD)' });
        body.initial_date = data;
      }
      comandos.push(await idface.enfileirarComando(req.db, disp.id, {
        endpoint: 'export_afd',
        body,
        queryString: String(formato) === '671' ? 'mode=671' : null,
      }));
    }

    res.json({ ok: true, comandos, aviso: 'O equipamento executa no proximo poll.' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/idface/dispositivos/:id/marcacoes', async (req, res) => {
  try {
    const { documento, inicio, fim, limite } = req.query;
    res.json(await idface.listarMarcacoes(req.db, {
      idDispositivo: Number(req.params.id), documento, dataInicio: inicio, dataFim: fim, limite,
    }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/idface/dispositivos/:id/usuarios', async (req, res) => {
  try { res.json(await idface.listarUsuarios(req.db, req.params.id)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/idface/dispositivos/:id/vinculos', async (req, res) => {
  try { res.json(await idface.listarVinculos(req.db, req.params.id)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/idface/dispositivos/:id/vinculos', async (req, res) => {
  try {
    const { deviceUserId, idPessoa = null, documento = null, origem = 'manual' } = req.body || {};
    if (deviceUserId == null) return res.status(400).json({ error: 'deviceUserId obrigatorio' });
    const v = await idface.vincularUsuario(req.db, {
      idDispositivo: Number(req.params.id), deviceUserId, idPessoa, documento, origem,
    });
    res.status(201).json(v);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Leitura consolidada para sistemas externos (MultiPonto, Secullum, etc.).
// Mesma autenticacao do resto: Basic (empresa) + X-Client-DB, ou JWT.
app.get('/api/idface/marcacoes', async (req, res) => {
  try {
    const { idDispositivo, documento, inicio, fim, limite } = req.query;
    res.json(await idface.listarMarcacoes(req.db, {
      idDispositivo: idDispositivo ? Number(idDispositivo) : null,
      documento, dataInicio: inicio, dataFim: fim, limite,
    }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/idface/arquivos', async (req, res) => {
  try {
    const { idDispositivo, limite } = req.query;
    res.json(await listarArquivos(req.db, {
      origem: 'idface', idDispositivo: idDispositivo ? Number(idDispositivo) : null, limite,
    }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/idface/arquivos/:id/download', async (req, res) => {
  try {
    const row = await lerArquivoAfd(req.db, req.params.id);
    if (!row) return res.status(404).json({ error: 'arquivo nao encontrado' });
    if (row.conteudo == null) return res.status(410).json({ error: row.erro || 'arquivo indisponivel' });
    res.setHeader('Content-Type', 'text/plain; charset=iso-8859-1');
    res.setHeader('Content-Disposition', `attachment; filename="${row.nome || 'AFD'}.txt"`);
    res.send(row.conteudo);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Arquivos estaticos da UI web (public/). Rotas /api/* acima tem precedencia.
app.use(express.static(path.join(__dirname, 'public')));

// Ultimo recurso: caminho desconhecido que NAO e' da UI e NAO e' /api. E' aqui
// que o REP cai se chamar o canal do iDCloud por um caminho que nao conheciamos.
// Sem isto o 404 engoliria a tentativa e o unico sintoma seria "nada acontece".
app.use(async (req, res) => {
  if (req.corpoBruto) {
    await gravarCaptura(req, req.corpoBruto);
    return res.status(200).json({ transactions: [] });
  }
  res.status(404).json({ error: 'Rota nao encontrada' });
});

// Poller silencioso multi-tenant (so roda se houver banco core)
try { iniciarPoller(getCorePool, getTenantPool); } catch {}

// Canal iDCloud: escuta TLS na 443 e coleta quando o REP conecta. So sobe se
// houver certificado — em desenvolvimento e na Railway (que nao serve esse
// canal) ele simplesmente nao existe, e o app segue normal pela API.
const CERT_PEM = process.env.IDCLOUD_CERT || path.join(__dirname, 'cert.pem');
const KEY_PEM = process.env.IDCLOUD_KEY || path.join(__dirname, 'chave.pem');
// Em Railway/container sem volume nao ha como montar arquivo: aceita o PEM no
// proprio env (multiline). Sem isso o canal so subia se o arquivo existisse.
const pemEnv = (v) => (v ? String(v).replace(/\\n/g, '\n') : null);
const certConteudo = pemEnv(process.env.IDCLOUD_CERT_PEM)
  || (fs.existsSync(CERT_PEM) ? fs.readFileSync(CERT_PEM) : null);
const keyConteudo = pemEnv(process.env.IDCLOUD_KEY_PEM)
  || (fs.existsSync(KEY_PEM) ? fs.readFileSync(KEY_PEM) : null);
if (certConteudo && keyConteudo) {
  import('./idcloudServer.js')
    .then(({ criarServidor }) => criarServidor({
      cert: certConteudo,
      key: keyConteudo,
      porta: Number(process.env.IDCLOUD_PORTA || 443),
      // IDCLOUD_HOST e' o host do MySQL e NAO pode ser reutilizado aqui: na VPS
      // ele costuma ser "localhost" (o canal ficaria so no loopback) e no
      // docker-compose e' "mysql" (que nem existe como interface local).
      host: process.env.IDCLOUD_BIND || '0.0.0.0',
    }))
    .then(() => console.log(`[idcloud] canal ativo em ${process.env.IDCLOUD_PORTA || 443}`))
    .catch((e) => console.error('[idcloud] nao subiu:', e.message));
} else {
  console.log('[idcloud] canal inativo (sem cert.pem/chave.pem) — a API segue normal');
}


// Cria/atualiza o esquema do core (idempotente) na inicializacao.
const detalheErro = (e) => [e.code, e.errno, e.sqlMessage, e.message].filter(Boolean).join(' | ') || String(e);
inicializarCore()
  .then(() => console.log('[startup] esquema do core garantido (izcloud_core + tabelas)'))
  // Migra os tenants existentes no boot: e' o que garante rep_coletas, Serial,
  // templates etc. em empresas criadas antes dessas colunas/tabelas. Sem isso o
  // canal do REP falha no primeiro contato com "table doesn't exist".
  .then(() => migrarTenantsExistentes())
  .then((falhas) => console.log(`[startup] tenants migrados (${falhas.length} falha(s))`))
  .catch((e) => console.error('[startup] FALHA no esquema do core/tenants:', detalheErro(e)));

// Verificacao de banco (aparece nos logs da Railway para facilitar debug)
verificarConexaoCore()
  .then((d) => {
    console.log(
      '[startup] DB core:', d.ok ? 'OK' : 'FALHOU', d.erro ? `(${d.erro})` : '',
      d.tabela_contas ? '' : '(tabela contas ausente)',
      d.colunas_ok ? '' : '(COLUNAS FALTANDO: ' + (d.faltando.join(', ') || 'desconhecido') + ')',
      d.tabelas_faltando.length ? '(TABELAS FALTANDO: ' + d.tabelas_faltando.join(', ') + ')' : ''
    );
  })
  .catch((e) => console.error('[startup] erro ao checar DB:', detalheErro(e)));

app.listen(PORT, () => console.log(`iZCloud (multi-tenant) rodando em http://localhost:${PORT}`));
