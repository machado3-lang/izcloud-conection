// core.js â€” Nucleo multi-tenant do iZCloud
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
    connectTimeout: 8000,
    charset: 'utf8mb4',
  };
}

function makePool(database) {
  const pool = mysql.createPool({
    ...cfg(),
    database,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 5,
  });
  // Evita que erros de conexao derrubem o processo (ex.: MySQL ausente/caiu).
  pool.on('error', (e) => console.error('[mysql] erro de pool:', e.code || e.message));
  return pool;
}

let _core = null;
export function getCorePool() {
  if (!_core) _core = makePool(process.env.CORE_DB || 'izcloud_core');
  return _core;
}

// Pool por tenant (cacheado). O "banco" do cliente e o schema.
const _tenants = new Map();
export function getTenantPool(schemaName) {
  if (!_tenants.has(schemaName)) {
    _tenants.set(schemaName, makePool(schemaName));
  }
  return _tenants.get(schemaName);
}

// Colunas que o app exige em producao. Se faltar alguma, o login quebra com
// ER_BAD_FIELD_ERROR — por isso `verificarConexaoCore` reporta e a migracao
// insiste ate resolver.
const COLUNAS_ESPERADAS = {
  contas: ['papel', 'ultimo_login', 'criado_por'],
  clientes: ['id_conta', 'razao_social', 'endereco', 'responsavel_nome', 'responsavel_cpf'],
};

// Tabelas que o app exige. Se `usuarios` faltar, o SELECT do login estoura com
// ER_NO_SUCH_TABLE e TODO login devolve 503. A ordem de criacao no
// schema_core.sql importa: um CREATE que falhe nao pode impedir os seguintes.
const TABELAS_ESPERADAS = ['contas', 'clientes', 'usuarios', 'admin_auditoria'];

// Diagnostico: conecta ao core, as tabelas existem e as colunas obrigatorias
// existem?
export async function verificarConexaoCore() {
  const db = process.env.CORE_DB || 'izcloud_core';
  const out = {
    host: cfg().host, port: cfg().port, database: db,
    ok: false, tabela_contas: false, colunas_ok: false, faltando: [],
    tabelas_faltando: [], erro: null,
  };
  try {
    const core = getCorePool();
    await core.query('SELECT 1');
    out.ok = true;
    // information_schema em vez de SHOW TABLES: explicito quanto ao schema.
    const [ex] = await core.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [db]
    );
    const temTabelas = new Set(ex.map((r) => r.TABLE_NAME));
    out.tabelas_faltando = TABELAS_ESPERADAS.filter((t) => !temTabelas.has(t));
    out.tabela_contas = temTabelas.has('contas');

    if (out.tabela_contas) {
      const [cols] = await core.query(
        'SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?)',
        [db, 'contas', 'clientes']
      );
      const tem = new Set(cols.map((r) => r.TABLE_NAME + '.' + r.COLUMN_NAME));
      for (const [tabela, lista] of Object.entries(COLUNAS_ESPERADAS)) {
        for (const col of lista) if (!tem.has(tabela + '.' + col)) out.faltando.push(tabela + '.' + col);
      }
      out.colunas_ok = out.faltando.length === 0;
    }
  } catch (e) {
    out.erro = e.message;
  }
  return out;
}

// Divide um .sql em statements.
//
// A ORDEM IMPORTA: os comentarios precisam sair ANTES do split por ';'. Um ';'
// dentro de um comentario (ex.: "-- A conta e o admin; aqui ficam os operadores")
// cortava o arquivo no meio da linha e o pedaco que sobrava virava SQL
// invalido -- que o MySQL rejeita, silenciosamente deixava de criar a tabela, e
// no caso de `usuarios` isso quebrava TODO login com ER_NO_SUCH_TABLE.
const VERBAO_SQL = /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SELECT|SET|USE|RENAME|TRUNCATE)\b/i;

export function sqlStatements(sql) {
  const semComentarios = sql
    .split('\n')
    .filter((l) => !/^\s*(--|#)/.test(l))
    .filter((l) => !/^\s*(CREATE\s+DATABASE|USE)\b/i.test(l))
    .join('\n');
  const statements = semComentarios.split(';').map((s) => s.trim()).filter(Boolean);
  // Guarda contra o arquivo voltar a ter lixo no meio: antes de enviar, cada
  // comando precisa comecar com uma palavra reservada.
  const suspectos = statements.filter((s) => !VERBAO_SQL.test(s));
  if (suspectos.length) {
    console.error('[sql] comando invalido (provavelmente sobra de comentario): ' +
      suspectos.map((s) => s.replace(/\s+/g, ' ').slice(0, 80)).join(' | '));
  }
  return statements.filter((s) => VERBAO_SQL.test(s));
}

// Cria o banco/tabelas do core (idempotente). Conecta SEM database (pois o
// banco pode nao existir ainda), cria o `izcloud_core` e depois roda o DDL das
// tabelas na mesma conexao.
export async function inicializarCore() {
  const db = process.env.CORE_DB || 'izcloud_core';
  const conn = await mysql.createConnection({ ...cfg() });
  let ddlErro = null;
  try {
    await conn.query('CREATE DATABASE IF NOT EXISTS ??', [db]);
    await conn.query('USE ??', [db]);
    const sql = fs.readFileSync(path.join(__dirname, 'schema_core.sql'), 'utf-8');
    // Cada CREATE roda independente: um unico comando com erro nao pode
    // impedir os seguintes. Sem isso, um `contas` que falha deixa `usuarios` e
    // `admin_auditoria` sem criacao — e o login passa a devolver 503 em TODA
    // tentativa, porque o SELECT de `usuarios` estoura com ER_NO_SUCH_TABLE.
    const erros = [];
    for (const st of sqlStatements(sql)) {
      try {
        await conn.query(st);
      } catch (e) {
        const alvo = st.match(/CREATE\s+(?:TABLE\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?|DATABASE(?:\s+IF NOT EXISTS)?\s+`?(\w+)`?)/i) || [];
        erros.push(`${alvo[1] || alvo[2] || st.slice(0, 40)}: ${[e.code, e.message].filter(Boolean).join(' | ')}`);
      }
    }
    if (erros.length) ddlErro = new Error(erros.join(' ;; '));
  } catch (e) {
    ddlErro = e;
  } finally {
    await conn.end();
  }

  // As migracoes rodam MESMO que o DDL tenha falhado: sao elas que garantem
  // as colunas que o login usa (contas.papel). Se nao rodarem, todo login
  // quebra com ER_BAD_FIELD_ERROR — e o painel fica inutilizavel sem aviso.
  await aplicarMigracoesComRetry();
  await garantirAdminBootstrap();

  if (ddlErro) throw ddlErro;
  return true;
}

// Insiste: uma migracao que falha na primeira tentativa (MySQL ainda subindo,
// lock de tabela) nao pode deixar o app sem colunas.
export async function aplicarMigracoesComRetry(tentativas = 3) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      await aplicarMigracoes();
      return true;
    } catch (e) {
      const erro = [e.code, e.errno, e.sqlMessage, e.message].filter(Boolean).join(' | ') || String(e);
      console.error(`[migracao] tentativa ${i}/${tentativas} falhou: ${erro}`);
      if (i < tentativas) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  const d = await verificarConexaoCore();
  console.error(
    '[migracao] FALHOU apos ' + tentativas + ' tentativas. Colunas faltando: ' +
    (d.faltando.length ? d.faltando.join(', ') : '(nenhuma — o problema e outro)') +
    '. O login vai falhar ate isso ser resolvido.'
  );
  return false;
}

// MySQL nao aceita `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (isso e do
// MariaDB), entao cada coluna nova e conferida em information_schema antes.
async function addColumnSeFaltar(conn, tabela, coluna, definicao) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [tabela, coluna]
  );
  if (r[0].n === 0) {
    await conn.query(`ALTER TABLE \`${tabela}\` ADD COLUMN ${coluna} ${definicao}`);
    console.log(`[migracao] ${tabela}.${coluna} criada`);
  }
}

// Colunas introduzidas depois do primeiro deploy. Idempotente: rodar em todo
// boot e o que mantem o banco da nuvem em dia sem migracao manual.
export async function aplicarMigracoes() {
  const db = process.env.CORE_DB || 'izcloud_core';
  const conn = await mysql.createConnection({ ...cfg(), database: db });
  try {
    await addColumnSeFaltar(conn, 'contas', 'papel', "ENUM('admin','cliente') NOT NULL DEFAULT 'cliente'");
    await addColumnSeFaltar(conn, 'contas', 'ultimo_login', 'DATETIME');
    await addColumnSeFaltar(conn, 'contas', 'criado_por', 'INT');
    await addColumnSeFaltar(conn, 'clientes', 'id_conta', 'INT');
    await addColumnSeFaltar(conn, 'clientes', 'razao_social', 'VARCHAR(160)');
    await addColumnSeFaltar(conn, 'clientes', 'endereco', 'VARCHAR(200)');
    await addColumnSeFaltar(conn, 'clientes', 'responsavel_nome', 'VARCHAR(120)');
    await addColumnSeFaltar(conn, 'clientes', 'responsavel_cpf', 'VARCHAR(20)');
  } finally {
    await conn.end();
  }
  return true;
}

// Cria (ou promove) a conta de administrador da plataforma a partir das env vars
// IZCLOUD_ADMIN_LOGIN / IZCLOUD_ADMIN_SENHA. Sem isso nao existe admin nenhum:
// o unico caminho seria o header IZCLOUD_ADMIN_KEY via curl.
export async function garantirAdminBootstrap() {
  const loginAdmin = process.env.IZCLOUD_ADMIN_LOGIN;
  const senhaAdmin = process.env.IZCLOUD_ADMIN_SENHA;
  if (!loginAdmin || !senhaAdmin) return null;

  const core = getCorePool();
  const [rows] = await core.query('SELECT id_conta, papel, ativo FROM contas WHERE login = ?', [loginAdmin]);
  if (rows.length) {
    if (rows[0].papel !== 'admin') {
      await core.query("UPDATE contas SET papel = 'admin' WHERE id_conta = ?", [rows[0].id_conta]);
      console.log(`[bootstrap] conta "${loginAdmin}" promovida a admin`);
    }
    return { id_conta: rows[0].id_conta, criado: false };
  }
  const [r] = await core.query(
    "INSERT INTO contas (login, senha_hash, nome, papel, ativo, criado_em) VALUES (?, ?, ?, 'admin', 1, NOW())",
    [loginAdmin, hashPassword(senhaAdmin), 'Administrador']
  );
  console.log(`[bootstrap] conta admin "${loginAdmin}" criada (id ${r.insertId})`);
  return { id_conta: r.insertId, criado: true };
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

// Hash descartavel, com o mesmo custo do scrypt real. Usado quando o login nao
// existe: sem isso, um login inexistente responderia muito mais rapido que um
// existente e a diferenca de tempo revelaria quais logins sao validos.
const HASH_DUMMY = hashPassword(crypto.randomBytes(24).toString('hex'));
function custoFixo() {
  crypto.scryptSync('custo-fixo', HASH_DUMMY.split(':')[0], 64);
}

// ---- Scripts SQL (criacao de schema de tenant) ----
// Usa o mesmo sqlStatements() do core: Comentario com ';' no meio quebra o
// schema da empresa do mesmo jeito que quebrava o core.
async function runScript(pool, sql) {
  for (const st of sqlStatements(sql)) {
    await pool.query(st);
  }
}

// Tabelas/colunas do contrato iDCloud que entraram depois do primeiro deploy.
// Roda em todo boot de empresa, idempotente (ver sqlStatements + a guarda de
// duplicados abaixo). Sem isso, um tenant criado antes dessas tabelas ficaria
// incompleto para o REP ler.
const TENANT_EXTRAS = {
  empregadores: `CREATE TABLE IF NOT EXISTS empregadores (
    id_Empregador INT AUTO_INCREMENT PRIMARY KEY,
    RazaoSocial VARCHAR(50), Local VARCHAR(100),
    CNPJ_CPF VARCHAR(20), CEI VARCHAR(20), CPF VARCHAR(20))`,
  departamentos: `CREATE TABLE IF NOT EXISTS departamentos (
    id_departamento INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(50), todos BIT DEFAULT 0)`,
  departamentos_equip: `CREATE TABLE IF NOT EXISTS departamentos_equip (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_departamento INT NOT NULL, id_Equipamento INT NOT NULL,
    UNIQUE KEY uq_dep_equip (id_departamento, id_Equipamento))`,
};

export async function aplicarMigracoesTenant(schema) {
  const pool = getTenantPool(schema);
  const aplicados = [];

  for (const [nome, ddl] of Object.entries(TENANT_EXTRAS)) {
    const [t] = await pool.query(`SHOW TABLES LIKE '${nome}'`);
    if (t.length) continue;
    await pool.query(ddl);
    aplicados.push(nome);
  }

  // Colunas novas
  const colunas = [
    ['equipamentos', 'Serial', 'VARCHAR(32)'],
    ['equipamentos', 'id_Empregador', 'INT'],
    ['templates', 'Template', 'LONGTEXT'],
    ['pessoas', 'Excluido', 'BIT DEFAULT 0'],
    ['pessoas', 'ExcluidoDefinitivo', 'BIT DEFAULT 0'],
    ['pessoas', 'id_departamento', 'INT'],
    ['pessoas', 'DataAtualizacao', 'DATETIME'],
  ];
  for (const [tabela, coluna, tipo] of colunas) {
    const [ex] = await pool.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [schema, tabela, coluna]
    );
    if (ex[0].n === 0) {
      await pool.query(`ALTER TABLE \`${tabela}\` ADD COLUMN \`${coluna}\` ${tipo}`);
      aplicados.push(`${tabela}.${coluna}`);
    }
  }

  // id_Equipamento precisa ser BIGINT em TODA tabela que o referencia: um serial
  // real tem 17 digitos (ex.: 00014003750029470) e nao cabe em INT (2.147.483.647).
  // Alargamento e seguro — os valores existentes cabem em BIGINT.
  const tabelasEquip = ['equipamentos', 'sync_status', 'equip_pessoa', 'afd', 'marcacoes', 'departamentos_equip'];
  for (const tabela of tabelasEquip) {
    const [t] = await pool.query(`SHOW TABLES LIKE '${tabela}'`);
    if (!t.length) continue;
    const [col] = await pool.query(
      'SELECT DATA_TYPE FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [schema, tabela, 'id_Equipamento']
    );
    if (col.length && col[0].DATA_TYPE === 'int') {
      // PRIMARY KEY e' NOT NULL por definicao; nos demais, a coluna original ja
      // era NOT NULL ou permite nulo — preservamos a opcao com MODIFY.
      const [nn] = await pool.query(
        'SELECT IS_NULLABLE FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [schema, tabela, 'id_Equipamento']
      );
      const nulo = nn.length && nn[0].IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL';
      await pool.query(`ALTER TABLE \`${tabela}\` MODIFY id_Equipamento BIGINT ${nulo}`);
      aplicados.push(`${tabela}.id_Equipamento -> BIGINT`);
    }
  }

  // Regra do Inmetro citada na doc do iDCloud: nao pode haver dois cartoes
  // (RFID) iguais em `pessoas`. Varias linhas com NULL continuam valendo.
  const [idx] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.STATISTICS ' +
    'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [schema, 'pessoas', 'Rfid']
  );
  const [dup] = await pool.query(
    'SELECT Rfid, COUNT(*) AS c FROM pessoas WHERE Rfid IS NOT NULL GROUP BY Rfid HAVING c > 1'
  );
  if (!idx[0].n) {
    if (dup.length) {
      console.error(`[migracao-tenant] ${schema}: ${dup.length} RFID(s) repetido(s) — ` +
        'indice unico de Rfid NAO criado. Resolva antes de conectar um REP.');
    } else {
      await pool.query('ALTER TABLE pessoas ADD UNIQUE KEY uq_rfid (Rfid)');
      aplicados.push('pessoas.uq_rfid');
    }
  }

  if (aplicados.length) console.log(`[migracao-tenant] ${schema}: ${aplicados.join(', ')}`);
  return aplicados;
}

// ---- CRUD de clientes (tenants) ----
// ---- Conta do cliente do iZCloud (login web; pode ter varias empresas) ----
export async function criarConta({ login, senha, nome, papel = 'cliente', criado_por = null }) {
  const core = getCorePool();
  const [ex] = await core.query('SELECT id_conta FROM contas WHERE login = ?', [login]);
  if (ex.length) throw new Error('Login ja existe');
  const [r] = await core.query(
    'INSERT INTO contas (login, senha_hash, nome, papel, criado_por, ativo, criado_em) VALUES (?, ?, ?, ?, ?, 1, NOW())',
    [login, hashPassword(senha), nome || null, papel === 'admin' ? 'admin' : 'cliente', criado_por]
  );
  return { id_conta: r.insertId, login };
}

export async function verificarConta(login, senha) {
  const core = getCorePool();
  const [rows] = await core.query(
    'SELECT id_conta, login, senha_hash, nome, papel, ativo FROM contas WHERE login = ?', [login]
  );
  if (!rows.length) { custoFixo(); return null; }
  const c = rows[0];
  if (!verifyPassword(senha, c.senha_hash)) return null;
  if (!c.ativo) return null;
  return { id_conta: c.id_conta, login: c.login, nome: c.nome, papel: c.papel || 'cliente' };
}

// Marca o ultimo login. Best-effort: falhar aqui nao pode impedir o login.
export async function registrarLogin(id_conta) {
  try {
    await getCorePool().query('UPDATE contas SET ultimo_login = NOW() WHERE id_conta = ?', [id_conta]);
  } catch (e) {
    console.error('[core] falha ao registrar ultimo_login:', e.message);
  }
}

// Perfil da conta a partir do id do token. Usado por GET /api/auth/eu: o front
// nao pode decidir permissao a partir de um 'papel' guardado no localStorage,
// que fica velho quando o papel muda (ou quando o deploy introduziu o campo).
export async function buscarConta(id_conta) {
  const core = getCorePool();
  const [rows] = await core.query(
    'SELECT id_conta, login, nome, papel, ativo, criado_em, ultimo_login FROM contas WHERE id_conta = ?',
    [id_conta]
  );
  if (!rows.length) return null;
  const c = rows[0];
  return {
    id_conta: c.id_conta, login: c.login, nome: c.nome,
    papel: c.papel || 'cliente', ativo: !!c.ativo,
    criado_em: c.criado_em, ultimo_login: c.ultimo_login,
  };
}

// Existe alguma conta de administrador na plataforma? Responde so sim/nao —
// nao diz quem e. Usado no diagnostico publico para orientar quem nao consegue
// entrar no painel de administracao.
export async function existeAdmin() {
  try {
    const core = getCorePool();
    const [r] = await core.query("SELECT COUNT(*) AS n FROM contas WHERE papel = 'admin' AND ativo = 1");
    return Number(r[0].n) > 0;
  } catch (e) {
    console.error('[core] falha ao contar admins:', e.message);
    return null;
  }
}

export async function listarEmpresas(id_conta) {
  const core = getCorePool();
  const [rows] = await core.query(
    'SELECT id_cliente, schema_name, razao_social, nome_empresa, cnpj, endereco, responsavel_nome, responsavel_cpf FROM clientes WHERE id_conta = ? AND ativo = 1 ORDER BY id_cliente',
    [id_conta]
  );
  return rows.map(r => ({
    id_cliente: r.id_cliente, schema: r.schema_name,
    razao_social: r.razao_social, nome_empresa: r.nome_empresa,
    cnpj: r.cnpj, endereco: r.endereco, responsavel_nome: r.responsavel_nome, responsavel_cpf: r.responsavel_cpf,
  }));
}

// ---- Empresa (tenant) vinculada a uma conta ----
export async function criarEmpresa({ id_conta, login, senha, nome_empresa, razao_social, cnpj, endereco, responsavel_nome, responsavel_cpf }) {
  const core = getCorePool();
  if (!login) throw new Error('Login da empresa e obrigatorio (acesso via API)');
  const [ex] = await core.query('SELECT id_cliente FROM clientes WHERE login = ?', [login]);
  if (ex.length) throw new Error('Login da empresa ja existe');
  const [r] = await core.query(
    `INSERT INTO clientes (id_conta, login, senha_hash, schema_name, razao_social, nome_empresa, cnpj, endereco, responsavel_nome, responsavel_cpf, ativo, criado_em)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 1, NOW())`,
    [id_conta, login, hashPassword(senha), razao_social || null, nome_empresa || null, cnpj || null, endereco || null, responsavel_nome || null, responsavel_cpf || null]
  );
  const id = r.insertId;
  const schema = 'tenant_' + String(id).padStart(4, '0');
  await core.query('UPDATE clientes SET schema_name = ? WHERE id_cliente = ?', [schema, id]);
  await core.query(`CREATE DATABASE IF NOT EXISTS \`${schema}\``);
  const tp = getTenantPool(schema);
  await runScript(tp, fs.readFileSync(path.join(__dirname, 'schema_tenant.sql'), 'utf-8'));
  // O runScript acima ja cria o schema completo; ainda assim, por seguranca
  // (e para tenants antigos), roda as migrating de contrato iDCloud.
  try { await aplicarMigracoesTenant(schema); } catch (e) {
    console.error(`[tenant] ${schema}: migracoes de contrato iDCloud falharam:`, e.message);
  }
  return { id_cliente: id, schema, login };
}

export async function atualizarEmpresa(id_conta, id_cliente, campos) {
  const core = getCorePool();
  const [own] = await core.query('SELECT id_cliente FROM clientes WHERE id_cliente = ? AND id_conta = ?', [id_cliente, id_conta]);
  if (!own.length) throw new Error('Empresa nao pertence a esta conta');
  const cols = [], vals = [];
  for (const k of ['razao_social', 'nome_empresa', 'cnpj', 'endereco', 'responsavel_nome', 'responsavel_cpf']) {
    if (campos[k] !== undefined) { cols.push(`${k} = ?`); vals.push(campos[k]); }
  }
  if (!cols.length) return { ok: true };
  vals.push(id_cliente);
  await core.query('UPDATE clientes SET ' + cols.join(', ') + ' WHERE id_cliente = ?', vals);
  return { ok: true };
}

export async function criarCliente({ login, senha, nome_empresa, cnpj, id_conta = null, razao_social = null, endereco = null, responsavel_nome = null, responsavel_cpf = null }) {
  const core = getCorePool();
  const [ex] = await core.query('SELECT id_cliente FROM clientes WHERE login = ?', [login]);
  if (ex.length) throw new Error('Login ja existe');

  const [r] = await core.query(
    `INSERT INTO clientes (id_conta, login, senha_hash, schema_name, razao_social, nome_empresa, cnpj, endereco, responsavel_nome, responsavel_cpf, ativo, criado_em)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 1, NOW())`,
    [id_conta, login, hashPassword(senha), razao_social, nome_empresa || null, cnpj || null, endereco, responsavel_nome, responsavel_cpf]
  );
  const id = r.insertId;
  const schema = 'tenant_' + String(id).padStart(4, '0');

  await core.query('UPDATE clientes SET schema_name = ? WHERE id_cliente = ?', [schema, id]);
  await core.query(`CREATE DATABASE IF NOT EXISTS \`${schema}\``);
  const tp = getTenantPool(schema);
  await runScript(tp, fs.readFileSync(path.join(__dirname, 'schema_tenant.sql'), 'utf-8'));
  try { await aplicarMigracoesTenant(schema); } catch (e) {
    console.error(`[tenant] ${schema}: migracoes de contrato iDCloud falharam:`, e.message);
  }
  return { id_cliente: id, schema, login };
}

// Cria (ou rotaciona) o usuario MySQL que o REP usara para se conectar
// diretamente no banco desta empresa, como no iDCloud oficial.
//
// Por que existe: o REP nao faz HTTP — ele abre um socket MySQL. Cada empresa
// recebe um usuario proprio, com GRANT apenas no proprio schema: e o que
// substitui o isolamento por "um banco so".
//
// O host/porta sao os do MySQL publico da nuvem (Railway MYSQL_PUBLIC_URL, ou o
// da VPS). O REP so aceita IPv4 literal no campo iDCloud, entao o endereco
// publico precisa estar em IP estavel.
export async function gerarCredencialRep(id_cliente, { usuario, pool } = {}) {
  const core = pool || getCorePool();
  const [rows] = await core.query('SELECT id_cliente, schema_name FROM clientes WHERE id_cliente = ?', [id_cliente]);
  if (!rows.length) throw new Error('Empresa nao encontrada');
  const schema = rows[0].schema_name;
  if (!/^tenant_\d{1,10}$/.test(schema || '')) throw new Error('Schema de tenant invalido: ' + schema);

  // Nome derivado do schema: nao aceita entrada do usuario como identificador
  // de objeto MySQL (evita injecao de SQL no GRANT/REVOKE).
  const sufixo = schema.replace('tenant_', '').padStart(4, '0');
  const nomeUsuario = String(usuario || `rep_${sufixo}`).replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
  if (!nomeUsuario) throw new Error('Usuario invalido');

  const senha = crypto.randomBytes(12).toString('base64url').slice(0, 16);
  // Substitui a senha se o usuario ja existia (rotacao).
  await core.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [nomeUsuario, senha]);
  await core.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [nomeUsuario, senha]);
  // ONLY o schema da empresa. Sem acesso a izcloud_core e sem outros tenants.
  await core.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${schema}\`.* TO ?@'%'`, [nomeUsuario]);
  await core.query('FLUSH PRIVILEGES');

  return {
    empresa: schema,
    usuario: nomeUsuario,
    senha,
    host: process.env.MYSQL_PUBLIC_HOST || 'IP_PUBLICO_DO_MYSQL',
    porta: Number(process.env.MYSQL_PUBLIC_PORT || 3306),
    observacao: 'Troque host/porta pelo endereco publico real do MySQL. ' +
      'O REP aceita apenas IPv4 literal no campo iDCloud.',
  };
}

export async function verificarCredenciais(login, senha) {
  const core = getCorePool();
  // 1) conta da empresa (tenant root) â€” tambem usada por sistemas externos
  const [rows] = await core.query(
    'SELECT id_cliente, login, senha_hash, schema_name, nome_empresa, ativo FROM clientes WHERE login = ?',
    [login]
  );
  if (rows.length) {
    const c = rows[0];
    if (c.ativo && verifyPassword(senha, c.senha_hash))
      return { id_cliente: c.id_cliente, schema_name: c.schema_name, login: c.login,
        nome_empresa: c.nome_empresa, tipo: 'empresa' };
    return null;
  }
  // 2) operador (usuario do tenant) â€” so para login web (JWT)
  const [ops] = await core.query(
    'SELECT id_usuario, id_cliente, schema_name, login, senha_hash, nome, nivel, ativo FROM usuarios WHERE login = ?',
    [login]
  );
  if (!ops.length) { custoFixo(); return null; }
  const u = ops[0];
  if (u.ativo && verifyPassword(senha, u.senha_hash))
    return { id_usuario: u.id_usuario, id_cliente: u.id_cliente, schema_name: u.schema_name, login: u.login,
      nome: u.nome, tipo: 'operador', nivel: u.nivel };
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

// =====================================================================
// ADMINISTRACAO DA PLATAFORMA (papel = 'admin')
// Estas funoes nao checam o acesso: quem chama e o middleware
// `authAdmin` (server.js), que exige JWT de conta com papel 'admin'.
// Nenhuma delas apaga dados — apenas desativa, para preservar os schemas
// tenant_XXXX e os dados de ponto.
// =====================================================================

// Lista todas as contas da plataforma + quantas empresas cada uma tem.
// O alias do GROUP_CONCAT nao pode ser `schemas`: SCHEMAS e palavra reservada
// no MySQL 8 e o servidor responde com erro de sintaxe perto do alias.
export async function listarContas() {
  const core = getCorePool();
  const [rows] = await core.query(
    `SELECT c.id_conta, c.login, c.nome, c.papel, c.ativo, c.criado_em, c.ultimo_login,
            (SELECT COUNT(*) FROM clientes e WHERE e.id_conta = c.id_conta) AS n_empresas,
            (SELECT COALESCE(GROUP_CONCAT(e.schema_name ORDER BY e.id_cliente), '')
               FROM clientes e WHERE e.id_conta = c.id_conta) AS schemas_csv
       FROM contas c ORDER BY c.papel DESC, c.id_conta`
  );
  return rows.map((r) => ({
    id_conta: r.id_conta,
    login: r.login,
    nome: r.nome,
    papel: r.papel || 'cliente',
    ativo: !!r.ativo,
    criado_em: r.criado_em,
    ultimo_login: r.ultimo_login,
    n_empresas: Number(r.n_empresas) || 0,
    schemas: r.schemas_csv ? String(r.schemas_csv).split(',') : [],
  }));
}

// Quantos admins ativos existem (protege contra o ultimo admin se rebaixar).
export async function contarAdminsAtivos() {
  const core = getCorePool();
  const [rows] = await core.query(
    "SELECT COUNT(*) AS n FROM contas WHERE papel = 'admin' AND ativo = 1"
  );
  return Number(rows[0].n) || 0;
}

// Edita nome / papel / ativo. Nao permite deixar a plataforma sem admin.
export async function atualizarConta(id_conta, campos, adminAtual) {
  const core = getCorePool();
  const [rows] = await core.query('SELECT id_conta, login, papel, ativo FROM contas WHERE id_conta = ?', [id_conta]);
  if (!rows.length) throw new Error('Conta nao encontrada');
  const alvo = rows[0];

  const cols = [], vals = [];
  if (campos.nome !== undefined) { cols.push('nome = ?'); vals.push(campos.nome); }
  if (campos.papel !== undefined) {
    const papel = campos.papel === 'admin' ? 'admin' : 'cliente';
    if (papel !== alvo.papel) {
      if (id_conta === adminAtual) throw new Error('Voce nao pode alterar o proprio papel');
      if (alvo.papel === 'admin' && (papel !== 'admin' || campos.ativo === false)) {
        if ((await contarAdminsAtivos()) <= 1) throw new Error('E preciso manter ao menos 1 administrador ativo');
      }
      cols.push('papel = ?'); vals.push(papel);
    }
  }
  if (campos.ativo !== undefined) {
    const ativo = campos.ativo ? 1 : 0;
    if (ativo !== (alvo.ativo ? 1 : 0)) {
      if (id_conta === adminAtual && !ativo) throw new Error('Voce nao pode desativar a propria conta');
      if (!ativo && alvo.papel === 'admin' && (await contarAdminsAtivos()) <= 1) {
        throw new Error('E preciso manter ao menos 1 administrador ativo');
      }
      cols.push('ativo = ?'); vals.push(ativo);
    }
  }
  if (!cols.length) return { ok: true, sem_mudanca: true };
  vals.push(id_conta);
  await core.query('UPDATE contas SET ' + cols.join(', ') + ' WHERE id_conta = ?', vals);
  return { ok: true };
}

export async function resetarSenhaConta(id_conta, senha) {
  const core = getCorePool();
  // affectedRows seria 0 se a senha nova fosse igual a atual — por isso a
  // consulta de existencia vem antes.
  const [rows] = await core.query('SELECT id_conta FROM contas WHERE id_conta = ?', [id_conta]);
  if (!rows.length) throw new Error('Conta nao encontrada');
  await core.query('UPDATE contas SET senha_hash = ? WHERE id_conta = ?', [hashPassword(senha), id_conta]);
  return { ok: true };
}

// Todas as empresas da plataforma, com o login da conta dona.
export async function listarTodasEmpresas() {
  const core = getCorePool();
  const [rows] = await core.query(
    `SELECT e.id_cliente, e.id_conta, e.login AS login_api, e.schema_name, e.razao_social, e.nome_empresa,
            e.cnpj, e.endereco, e.responsavel_nome, e.responsavel_cpf, e.ativo, e.criado_em,
            c.login AS login_conta, c.nome AS nome_conta
       FROM clientes e LEFT JOIN contas c ON c.id_conta = e.id_conta
      ORDER BY e.id_cliente`
  );
  return rows.map((r) => ({
    id_cliente: r.id_cliente,
    id_conta: r.id_conta,
    login_api: r.login_api,
    schema: r.schema_name,
    razao_social: r.razao_social,
    nome_empresa: r.nome_empresa,
    cnpj: r.cnpj,
    endereco: r.endereco,
    responsavel_nome: r.responsavel_nome,
    responsavel_cpf: r.responsavel_cpf,
    ativo: !!r.ativo,
    criado_em: r.criado_em,
    login_conta: r.login_conta,
    nome_conta: r.nome_conta,
  }));
}

// Edita qualquer empresa (sem exigir que pertenca a conta do admin) e/ou
// desativa. Desativar preserva o schema e os dados.
export async function atualizarEmpresaAdmin(id_cliente, campos) {
  const core = getCorePool();
  const [rows] = await core.query('SELECT id_cliente FROM clientes WHERE id_cliente = ?', [id_cliente]);
  if (!rows.length) throw new Error('Empresa nao encontrada');
  const cols = [], vals = [];
  for (const k of ['razao_social', 'nome_empresa', 'cnpj', 'endereco', 'responsavel_nome', 'responsavel_cpf']) {
    if (campos[k] !== undefined) { cols.push(`${k} = ?`); vals.push(campos[k]); }
  }
  if (campos.ativo !== undefined) { cols.push('ativo = ?'); vals.push(campos.ativo ? 1 : 0); }
  if (!cols.length) return { ok: true, sem_mudanca: true };
  vals.push(id_cliente);
  await core.query('UPDATE clientes SET ' + cols.join(', ') + ' WHERE id_cliente = ?', vals);
  return { ok: true };
}

// ---- Auditoria ----
export async function auditar({ id_conta, acao, alvo = null, detalhes = null, ip = null }) {
  try {
    await getCorePool().query(
      'INSERT INTO admin_auditoria (id_conta, acao, alvo, detalhes, ip, criado_em) VALUES (?, ?, ?, ?, ?, NOW())',
      [id_conta, acao, alvo, detalhes ? String(detalhes).slice(0, 2000) : null, ip]
    );
  } catch (e) {
    console.error('[core] falha ao auditar:', e.message);
  }
}

export async function listarAuditoria(limite = 100) {
  const core = getCorePool();
  const n = Math.min(Math.max(Number(limite) || 100, 1), 500);
  const [rows] = await core.query(
    `SELECT a.id, a.acao, a.alvo, a.detalhes, a.ip, a.criado_em, c.login AS admin_login
       FROM admin_auditoria a LEFT JOIN contas c ON c.id_conta = a.id_conta
      ORDER BY a.id DESC LIMIT ${n}`
  );
  return rows;
}
