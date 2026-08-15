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
import { getCorePool, getTenantPool, criarCliente, listarClientes } from './core.js';
import { login, authTenant, requireAdmin } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AFD_DIR = path.join(__dirname, 'data', 'afd');
if (!fs.existsSync(AFD_DIR)) fs.mkdirSync(AFD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3100;

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

// Login -> JWT + "numero do banco" do cliente (estilo iDCloud)
app.post('/api/auth/login', (req, res) => {
  try { res.json(login(req.body.login, req.body.senha)); }
  catch (e) { res.status(401).json({ error: e.message }); }
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
    const { id_Equipamento, Nome, IpAddress, Porta, Passcode, REPType } = req.body;
    const client = new IdCloudClient(req.db);
    await client.pool.query(
      `INSERT INTO equipamentos
       (id_Equipamento, Nome, IpAddress, Porta, Passcode, REPType, DataAtualizacao)
       VALUES (?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE Nome=VALUES(Nome), IpAddress=VALUES(IpAddress),
         Porta=VALUES(Porta), Passcode=VALUES(Passcode), REPType=VALUES(REPType)`,
      [id_Equipamento, Nome, IpAddress, Porta, Passcode, REPType]
    );
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/reps', async (req, res) => {
  try { res.json(await new IdCloudClient(req.db).listarEquipamentos()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Pessoas (escopo do tenant) ----------
app.post('/api/pessoas', async (req, res) => {
  try {
    const { rep, pessoa } = req.body;
    const r = await enviarUsuarios(rep.ip, rep.porta, [pessoa], rep.portaria, rep.usuario, rep.senha);
    const id = await new IdCloudClient(req.db).gravarPessoa({ ...pessoa, portaria: rep.portaria });
    res.json({ rep: r, idNuvem: id });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- AFD (escopo do tenant) ----------
// Sincronizacao incremental manual/trig
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

// Poller silencioso multi-tenant (so roda se houver banco core)
try { iniciarPoller(getCorePool, getTenantPool); } catch {}

app.listen(PORT, () => console.log(`iZCloud (multi-tenant) rodando em http://localhost:${PORT}`));
