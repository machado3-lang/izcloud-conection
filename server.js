// server.js — API multi-tenant do iZCloud (nossa nuvem para REPs 1510/671)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { probe, enviarUsuarios } from './repClient.js';
import { IdCloudClient } from './idcloud.js';
import { gerarPorPeriodo } from './afd.js';
import { sincronizarAfd, iniciarPoller } from './sync.js';
import { getCorePool, getTenantPool, criarCliente, listarClientes, criarUsuario, listarUsuarios, removerUsuario, criarConta, verificarConta, listarEmpresas, criarEmpresa, atualizarEmpresa } from './core.js';
import { login, authTenant, authConta, requireAdmin, requireTenantAdmin } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AFD_DIR = path.join(__dirname, 'data', 'afd');
if (!fs.existsSync(AFD_DIR)) fs.mkdirSync(AFD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3100;

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

// ---------- Autenticacao / Tenants ----------
// Cria conta de cliente (setup). Protegido por IZCLOUD_ADMIN_KEY.
app.post('/api/auth/register', requireAdmin, async (req, res) => {
  try {
    const r = await criarCliente(req.body); // { login, senha, nome_empresa, cnpj }
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Lista clientes (admin)
app.get('/api/auth/clientes', requireAdmin, async (_, res) => {
  try { res.json(await listarClientes()); } catch (e) { res.status(502).json({ error: e.message }); }
});

// Login -> JWT de CONTA + lista de empresas da conta (estilo iZCloud)
app.post('/api/auth/login', async (req, res) => {
  try { res.json(await login(req.body.login, req.body.senha)); }
  catch (e) { res.status(401).json({ error: e.message }); }
});

// Registro publico: cria a CONTA do cliente e (opcional) a 1a empresa.
app.post('/api/auth/registro', async (req, res) => {
  try {
    const { login: loginU, senha, nome, empresa } = req.body;
    const c = await criarConta({ login: loginU, senha, nome });
    if (empresa && empresa.login) {
      await criarEmpresa({ id_conta: c.id_conta, ...empresa });
    }
    // reaproveita o login para retornar token + empresas
    res.json(await login(loginU, senha));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Empresas (escopo da CONTA) ----------
app.use('/api/empresas', authConta);

app.get('/api/empresas', async (req, res) => {
  try { res.json(await listarEmpresas(req.conta.id_conta)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/empresas', async (req, res) => {
  try {
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

// ---------- Usuarios/operadores do tenant (multi-usuario por empresa) ----------
// Apenas a conta da empresa ou um operador admin pode gerenciar.
app.use('/api/auth/usuarios', authTenant, requireTenantAdmin);

app.get('/api/auth/usuarios', async (req, res) => {
  try { res.json(await listarUsuarios(req.tenant.id_cliente)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/auth/usuarios', async (req, res) => {
  try {
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

app.listen(PORT, () => console.log(`iZCloud (multi-tenant) rodando em http://localhost:${PORT}`));
