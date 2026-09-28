// server.js — API multi-tenant do iZCloud (nossa nuvem para REPs 1510/671)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { probe, enviarUsuarios, lerUsuarios, mapearUsuario } from './repClient.js';
import { IdCloudClient } from './idcloud.js';
import { gerarPorPeriodo } from './afd.js';
import { sincronizarAfd, iniciarPoller } from './sync.js';
import { getCorePool, getTenantPool, verificarConexaoCore, inicializarCore, criarCliente, listarClientes, criarUsuario, listarUsuarios, removerUsuario, criarConta, verificarConta, buscarConta, existeAdmin, listarEmpresas, criarEmpresa, atualizarEmpresa, listarContas, atualizarConta, resetarSenhaConta, listarTodasEmpresas, atualizarEmpresaAdmin, auditar, listarAuditoria } from './core.js';
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

// 50MB de JSON em rota publica e um DoS facil; 20MB sobra para import de AFD.
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
// IZCLOUD_ADMIN_KEY — o endpoint e publico, entao nao pode vazar a topologia
// interna da nuvem.
app.get('/api/health/db', adminKey, async (_, res) => {
  try { res.json(await verificarConexaoCore()); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// Mesmo diagnostico, versao publica e sem dados sensiveis. `faltando` lista as
// colunas obrigatorias que ainda nao existem no core — e o que explica um
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
// ADMINISTRACAO DA PLATAFORMA (/api/admin/*) — tela public/admin.html
// Equivale ao "criar as contas dos usuarios" do iDCloud: o admin cria o login
// e a senha de cada cliente, que depois administra as proprias empresas.
// Regra: nada e apagado, apenas desativado (preserva schemas e dados de ponto).
// =====================================================================
app.use('/api/admin', authAdmin);

const CAMPOS_EMPRESA = ['razao_social', 'nome_empresa', 'cnpj', 'endereco', 'responsavel_nome', 'responsavel_cpf'];
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

// Todas as rotas abaixo exigem autenticacao e sao ESCOPADAS ao tenant do cliente.
app.use('/api/reps', authTenant);
app.use('/api/pessoas', authTenant);
app.use('/api/afd', authTenant);

// ---------- REPs (escopo do tenant) ----------
app.post('/api/reps/probe', async (req, res) => {
  try { res.json(await probe(req.body.ip, req.body.porta || 443, req.body.usuario, req.body.senha)); }
  catch (e) { res.status(502).json({ error: 'Falha ao sondar REP', detalhe: e.message }); }
});

app.post('/api/reps', async (req, res) => {
  try {
    const { id_Equipamento, Nome, IpAddress, Porta, Passcode, REPType, ModoConexao } = req.body;
    const client = new IdCloudClient(req.db);
    await client.pool.query(
      `INSERT INTO equipamentos
       (id_Equipamento, Nome, IpAddress, Porta, Passcode, REPType, ModoConexao, DataAtualizacao)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE Nome=VALUES(Nome), IpAddress=VALUES(IpAddress),
         Porta=VALUES(Porta), Passcode=VALUES(Passcode), REPType=VALUES(REPType), ModoConexao=VALUES(ModoConexao)`,
      [id_Equipamento, Nome, IpAddress, Porta, Passcode, REPType, ModoConexao || 'nuvem_puxa']
    );
    res.json({ ok: true });
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

// Importar usuarios + biometria DA memoria do REP para o iZCloud (e vincula ao REP)
app.post('/api/pessoas/importar', async (req, res) => {
  try {
    const { rep, idEquipamento } = req.body;
    const lista = await lerUsuarios(rep.ip, rep.porta || 443, rep.usuario || 'admin', rep.senha || 'admin');
    const client = new IdCloudClient(req.db);
    let pessoas = 0, templates = 0;
    for (const u of lista) {
      const m = mapearUsuario(u);
      const idP = await client.importarPessoa({ pis: m.pis, cpf: m.cpf, nome: m.nome, portaria: m.tipo });
      await client.vincularEquipamento(idP, idEquipamento);
      for (const t of m.templates) { await client.gravarTemplate(idP, t.tipo, t.indice, t.dados); templates++; }
      pessoas++;
    }
    res.json({ ok: true, pessoas, templates });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Enviar ao REP apenas os funcionarios VINCULADOS a ele (filtrado por equip_pessoa) + biometria
app.post('/api/pessoas/sincronizar', async (req, res) => {
  try {
    const { rep, idEquipamento } = req.body;
    const client = new IdCloudClient(req.db);
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
    const r = await enviarUsuarios(rep.ip, rep.porta || 443, users, portaria, rep.usuario || 'admin', rep.senha || 'admin');
    res.json({ ok: true, enviados: users.length, rep: r });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/pessoas', async (req, res) => {
  try {
    const { rep, pessoa } = req.body;
    const r = await enviarUsuarios(rep.ip, rep.porta, [pessoa], rep.portaria, rep.usuario, rep.senha);
    const id = await new IdCloudClient(req.db).gravarPessoa({ ...pessoa, portaria: rep.portaria });
    res.json({ rep: r, idNuvem: id });
  } catch (e) { res.status(502).json({ error: e.message }); }
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
    const { texto, total } = gerarPorPeriodo({
      linhasCruas: rows.map(r => r.Dado).filter(Boolean),
      serial, dataInicio, dataFim, formato,
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
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
    const { texto } = gerarPorPeriodo({ linhasCruas: rows.map(r => r.Dado).filter(Boolean), serial: rep.serial, formato: mode });
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
    const arquivo = path.join(AFD_DIR, req.tenant.schema, `import_${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, linhas.join('\r\n'), 'utf-8');
    res.json({ total: linhas.length, arquivo });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Arquivos estaticos da UI web (public/). Rotas /api/* acima tem precedencia.
app.use(express.static(path.join(__dirname, 'public')));

// Poller silencioso multi-tenant (so roda se houver banco core)
try { iniciarPoller(getCorePool, getTenantPool); } catch {}

// Cria/atualiza o esquema do core (idempotente) na inicializacao.
const detalheErro = (e) => [e.code, e.errno, e.sqlMessage, e.message].filter(Boolean).join(' | ') || String(e);
inicializarCore()
  .then(() => console.log('[startup] esquema do core garantido (izcloud_core + tabelas)'))
  .catch((e) => console.error('[startup] FALHA ao criar esquema do core:', detalheErro(e)));

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
