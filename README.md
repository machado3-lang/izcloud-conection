# iZCloud — Nuvem própria para REPs ControlID (1510 / 671)

Sistema para gerenciar pontos de marcação **ControlID iDClass (1510 e 671)** via
própria nuvem, inspirado no modelo do **iDCloud** da ControlID — porém **sem usar o
serviço pago deles** e com controle total dos dados.

> Escopo: **somente 1510/671**. iDFace / REP-P (modo PUSH/poll) ficam de fora.

> **Escopo deste repositório:** este é o sistema real (Node.js + MySQL). O projeto
> em `C:\Producao\Gerenciador REPs\opencode` (.NET) é um esqueleto incompleto e
> **separado** — não deve ser usado. "iZCloud" (nosso) ≠ "iDCloud" (serviço pago da
> ControlID, que estamos substituindo).

---

## 1. O que o iZCloud faz

| Funcionalidade | Status |
|---|---|
| Cadastro de REP por IP (auto-detecta 1510/671 via FCGI) | ✅ testado em hardware real |
| Envio de pessoas para a memória do REP (1510→PIS, 671→CPF) | ✅ ciclo completo validado |
| Download de AFD (layout 1510 clássico / 671 ISO) | ✅ 38523 linhas baixadas |
| **Sincronização incremental por NSR** (modelo "empurrar para a nuvem") | ✅ implementado |
| Export de AFD por período (para qualquer sistema/usuário) | ✅ implementado |
| Import manual de AFD (ex.: sistema externo manda o arquivo) | ✅ implementado |
| Fetch para sistemas externos (ex.: Secullum) | ✅ implementado |
| **Multi-usuário por empresa** (conta da empresa + operadores admin/operador) | ✅ implementado |
| **Modo de conexão por REP** (`nuvem_puxa` = iZCloud puxa; `rep_empurra` = REP empurra) | ✅ implementado |

---

## 2. Arquitetura

```
 REP 1510/671 (FCGI HTTPS/HTTP)
      │  login / get_afd / add_users / get_about
      ▼
 repClient.js  ──► proxyREP (fallback http se https falhar)
      │
      ├─► probe (auto-detect 1510/671)   cadastro
      ├─► enviarUsuarios (grava na memória do REP)
      └─► get_afd (baixa AFD incremental por NSR)
            │
            ▼
      sync.js  ──► sincronizarAfd (filtra NSR > last_nsr, insere no MySQL)
            │
            ▼
 idcloud.js  ──► schema DO CLIENTE (tenant_XXXX) — MySQL da NOSSA nuvem
      │
      ├─ afd (Dado = linha crua, idempotente por NSR)
      ├─ equipamentos / sync_status
      └─ pessoas
            ▲
            │  core.js resolve login -> schema
      clientes (izcloud_core)  ──► auth.js (JWT / Basic+DB)
            │
            ▼
 server.js (Express)  ──► /api/*   (web do operador + sistemas externos)
```

Banco do iZCloud é **MySQL próprio** (modelo iDCloud). Cada **cliente** tem o seu
próprio **schema** (`tenant_XXXX`) — igual ao "número do banco" do iDCloud da
ControlID. O schema `izcloud_core` guarda apenas as contas (`clientes`).

---

## 2b. Multi-tenant (contas de clientes)

Cada **cliente** (empresa) tem sua própria conta e enxerga **apenas os seus dados**
(REPs, pessoas, AFD, empresa). Implementado com **um schema MySQL por cliente**:

- `izcloud_core.clientes`: `id_cliente`, `login`, `senha_hash` (scrypt), `schema_name`
  (ex.: `tenant_0007` = "número do banco"), `nome_empresa`, `cnpj`.
- Toda tabela de dados (`equipamentos`, `pessoas`, `afd`, `sync_status`, …) vive
  **dentro do schema do cliente** — não há coluna `id_cliente` (o próprio schema
  isola). Backup/restauração por cliente = dump do schema.

**Acesso estilo iDCloud (para sistemas externos, ex.: Secullum):**

| Dado que a ControlID entrega | No iZCloud |
|---|---|
| Endereço do servidor iDCloud | URL `https://<ip-izcloud>:3100` |
| Nome de usuário | `login` do cliente |
| Senha de login | `senha` do cliente |
| Número do banco de dados | `schema_name` (enviado em `X-Client-DB`) |

Dois modos de autenticação (`auth.js`):
1. **Web**: `POST /api/auth/login` → `Authorization: Bearer <JWT>`. Aceita **tanto a conta da
   empresa quanto operadores** do tenant (multi-usuário).
2. **Sistema externo**: `Authorization: Basic <user:pass>` + header `X-Client-DB: <schema>`. O
   iZCloud valida credenciais **e** confere se o banco informado pertence àquele cliente. **Somente a
   conta da empresa** pode ser usada aqui (operadores são bloqueados — `403`), pois trata-se de
   máquina-a-máquina com o "número do banco".

Fluxo de criação de cliente: `POST /api/auth/register` (protegido por
`IZCLOUD_ADMIN_KEY`) → cria o schema `tenant_XXXX`, roda `schema_tenant.sql` e
registra a conta em `izcloud_core`. O poller (`sync.js`) itera **todos** os
tenants ativos e sincroniza os REPs de cada um.

---

## 3. Diferença 1510 × 671 (fundamental)

Ambos usam registro tipo `3`. A linha tipo `3` tem 9 caracteres de NSR + 1 de tipo.

| Campo | 1510 (clássico) | 671 (ISO) |
|---|---|---|
| Detecta? | pos14 **não** é `-` | pos14 **é** `-` |
| Documento | **PIS** em `Dado[22-34]` (12) | **CPF** em `Dado[34-45]` (11) |
| Data/hora | `DDMMAAAA` + `HHMM` (pos 10-22) | `YYYY-MM-DDTHH:MM:SS` (pos 10-29) |
| Envio de usuário | `add_users` (sem parâmetro) | `add_users?mode=671` |
| Download AFD | `get_afd` | `get_afd?mode=671` |

A **detecção definitiva** é via `get_afd?mode=671`: se a primeira batida tiver
`-` na posição 14 → 671; se der erro ou voltar layout clássico → 1510.

> Firmware: `versionFW` da API é **decimal**; o display mostra **hex**
> (`1048` = `0x418` = "418"; `versionMRP 1560` = `0x618` = MRP 618).
> Firmware 671 começa em 1000+, mas a detecção por AFD é infalível.

---

## 4. Fluxo de dados

### 4.1 Cadastro de REP (auto-detect)
`POST /api/reps/probe` → `probe()` faz login + `get_afd?mode=671` e devolve
`portaria: '1510' | '671'`. Em seguida `POST /api/reps` grava em `equipamentos`
com `IpAddress`, `Porta`, `Passcode`, `REPType`.

### 4.2 Envio de pessoas
`POST /api/pessoas` → `enviarUsuarios()` grava na memória do REP (via FCGI) e
`gravarPessoa()` persiste em `pessoas` (PIS ou CPF conforme portaria).

### 4.3 Sincronização incremental (NSR)
Modelo **"empurrar para a nuvem"** — o servidor consulta o REP continuamente:

1. `sync_status.last_nsr` indica o último NSR já salvo.
2. `sincronizarAfd()` pede `get_afd` com `initial_nsr = last_nsr + 1`
   (se o firmware ignorar, filtra client-side `NSR > last_nsr`).
3. Insere apenas as novas batidas em `afd` (idempotente via
   `ON DUPLICATE KEY UPDATE`).
4. Atualiza `sync_status.last_nsr` e `last_sync`.
5. Um **poller silencioso** (`iniciarPoller`) roda a cada 60s para todos os
   equipamentos ativos.

### 4.4 Export / Import / Fetch
- `POST /api/afd/export` → gera arquivo AFD por período (qualquer usuário baixa).
- `POST /api/afd/import` → recebe AFD de sistema externo e salva em `afd`.
- `POST /api/afd/fetch` → sincroniza e devolve as novas marcações (ex.: Secullum
  chama para importar).

---

## 5. Como apontar o REP para o iZCloud

O REP (iDClass) aceita um **IP de iDCloud** configurável. Use o **REPCONFIG.exe**
(`C:\Producao\Gerenciador REPs\REPCONFIG.exe`) para gravar o IP/domínio do
servidor iZCloud no campo `configOffSetIPiDCloud` / `txtIPCloud`. A comunicação
REP↔nuvem é **HTTPS/JSON (FCGI)**.

> Opcional: se o REP não conseguir "empurrar", o iZCloud faz o inverso via
> **FCGI IP-direto** (mesma lógica de `repClient.js`), sem exigir IP estático.

---

## 6. Deploy (IP estático)

- **Oracle Cloud Free** (recomendado): VM sempre-on + IP público estático fixo.
  Necessário para o REP conseguir empurrar para a nuvem.
- **Railway**: só dá domínio, sem IP fixo → trava o modo "REP empurra"; use
  apenas no modo FCGI IP-direto.

Arquivos de apoio: `docker-compose.yml` (MySQL + Node), `.env.example`.

---

## 7. Estrutura de arquivos

| Arquivo | Função |
|---|---|
| `repClient.js` | Cliente FCGI dos REPs (login, probe, add_users, get_afd, detecção 1510/671) |
| `idcloud.js` | Cliente do schema do cliente (ler/gravar `afd`, `pessoas`, `equipamentos`, `sync_status`) |
| `afd.js` | Parser 1510/671 + `gerarPorPeriodo` (gera AFD reimportável) |
| `sync.js` | `sincronizarAfd` (incremental NSR) + `iniciarPoller` (silencioso, itera tenants) |
| `core.js` | Núcleo multi-tenant: pool core + pool por schema + criar/verificar clientes |
| `auth.js` | Login JWT + middleware `authTenant` (Bearer ou Basic+`X-Client-DB`) |
| `server.js` | API Express multi-tenant (`/api/auth/*`, `/api/reps`, `/api/pessoas`, `/api/afd/*`) |
| `schema_core.sql` | Banco `izcloud_core` (tabela `clientes`) |
| `schema_tenant.sql` | Tabelas de UM cliente (executado dentro de `tenant_XXXX`) |
| `test_*.mjs` | Testes contra REP real (IP 192.168.100.132) |

---

## 8. Como rodar

```bash
cd C:\Producao\iZCloud
npm install
cp .env.example .env   # preencha IDCLOUD_* e PORT
npm start               # http://localhost:3100
```

Variáveis de ambiente:

```
IDCLOUD_HOST=localhost
IDCLOUD_PORT=3306
IDCLOUD_USER=root
IDCLOUD_PASS=senha
CORE_DB=izcloud_core          # banco de contas (clientes/tenants)
JWT_SECRET=gere_um_segredo
IZCLOUD_ADMIN_KEY=chave_setup # protege /api/auth/register
PORT=3100
```

Banco:

```bash
mysql -u root -p < schema_core.sql   # cria izcloud_core + tabela clientes
# schemas dos clientes sao criados via /api/auth/register
```

Criar o primeiro cliente (setup):

```bash
curl -X POST http://localhost:3100/api/auth/register \
  -H "x-admin-key: chave_setup" \
  -H "Content-Type: application/json" \
  -d '{"login":"empresa1","senha":"segura123","nome_empresa":"Empresa 1","cnpj":"12345678000100"}'
# => { "ok": true, "id_cliente": 1, "schema": "tenant_0001", "login": "empresa1" }
```

Login (web → JWT):

```bash
curl -X POST http://localhost:3100/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"login":"empresa1","senha":"segura123"}'
# => { "token": "...", "schema": "tenant_0001", "database": "tenant_0001" }
```

Acesso de sistema externo (estilo iDCloud: usuario + senha + numero do banco):

```bash
curl -X POST http://localhost:3100/api/afd/export \
  -H "Authorization: Basic $(echo -n empresa1:segura123 | base64)" \
  -H "X-Client-DB: tenant_0001" \
  -H "Content-Type: application/json" \
  -d '{"idEquipamento":1,"dataInicio":"2024-01-01","dataFim":"2024-12-31"}'
```

---

## 9. Testes já realizados (REP de homologação)

- IP `192.168.100.132`, porta 443, admin/admin
- iDClass Mult, serial `00014003750029470`, firmware `1048` (display "418"), MRP `1560` ("618")
- `probe` → `portaria: "1510"` ✅
- `baixarAfd` → **38523 linhas** (formato 1510, pos14 = `2`) ✅
- Ciclo de escrita: `add_users` (PIS 99999999999) → `load_users` → `remove_users`,
  com restauração do usuário original (PIS 12345678901) ✅

---

## 10. Deploy em Oracle Cloud Free

VM sempre-on + **IP público estático** (exigido para o REP "empurrar" para a nuvem).
Use o `docker-compose.yml` (MySQL + Node) ou MySQL nativo.

1. **IP estático**: anote o IP público da VM — é ele que vai no REPCONFIG
   (campo iDCloud) e que o Secullum/systemas externos usam como "servidor".
2. **Firewall / Security Lists**: abra `3306` (MySQL) e `3100` (API iZCloud)
   para `0.0.0.0/0` (reestreia por IP depois).
3. **Banco**: `mysql -u root -p < schema_core.sql` (cria `izcloud_core`); os
   schemas dos clientes são criados via `/api/auth/register`.
4. **Variáveis** (`.env` / `docker-compose`): defina `IDCLOUD_PASS`,
   `JWT_SECRET` e `IZCLOUD_ADMIN_KEY` **fortes**; `CORE_DB=izcloud_core`.
5. **Primeiro cliente (setup)**:
   ```bash
   curl -X POST http://<IP>:3100/api/auth/register \
     -H "x-admin-key: <IZCLOUD_ADMIN_KEY>" \
     -H "Content-Type: application/json" \
     -d '{"login":"empresa1","senha":"<senha>","nome_empresa":"Empresa 1","cnpj":"..."}'
   ```
6. **Apontar o REP**: no `REPCONFIG.exe`, defina o IP do iDCloud = `<IP>:3100`
   (campo `configOffSetIPiDCloud` / `txtIPCloud`).
7. **Testar fluxo**: `login` → `/api/reps/probe` → `/api/reps` → `/api/afd/sync`.

> Sem IP estático (ex.: Railway), use apenas o modo **FCGI IP-direto** do
> `repClient.js` (o iZCloud puxa do REP), pois o REP não consegue empurrar.

---

## 11. Próximos passos sugeridos

- Configurar REPCONFIG.exe com o IP público do iZCloud.
- ~~(Opcional) UI web mínima para cadastro/export~~ ✅ **feito** (`public/index.html` — SPA que consome `/api/*`).
- Tratar `get_afd` paginado para REPs com AFD muito grande.
- Backup por tenant: `mysqldump <schema>` de cada `tenant_XXXX`.

---

## 12. Documentação de trabalho — estado atual (sessão opencode)

Esta seção registra a análise e as alterações feitas, para retomada futura.
**Objetivo:** subir o iZCloud em nuvem (IP fixo) e apontar os REPs reais via
`REPCONFIG.exe`. O fluxo em REP real (homologação) **já foi testado** (ver §9).

### 12.1 Esclarecimento de escopo (importante)
- **iZCloud = este repositório (Node.js + MySQL).** É o sistema que vamos usar.
- `C:\Producao\Gerenciador REPs\opencode` (.NET) é um esqueleto incompleto e
  separado (não compila, não tem controllers além de Health). **Não usar.**
- "iZCloud" (nosso) ≠ "iDCloud" (serviço pago da ControlID que substituímos).
  A ferramenta oficial `Gerenciador REPs\AFD Downloader` (ControliD.iDCloud.*)
  serve só como referência de formato.

### 12.2 Dois modos de integração com o REP (revisão)
1. **IP direto via FCGI** — `repClient.js` fala HTTPS/HTTP (porta 443/80) com o
   REP: `login`, `get_afd`, `add_users`, `get_about`. Auto-detecta 1510/671. ✅
2. **"Push" / apontar o REP para a nuvem** — configuramos o REP com o **IP do
   iZCloud** usando `REPCONFIG.exe`
   (`C:\Producao\Gerenciador REPs\REPCONFIG.exe`; mesma família do
   `repidclass_config.exe`), campo iDCloud = IP da VM (ex.: `configOffSetIPiDCloud`
   / `txtIPCloud`). O iZCloud então sincroniza via **poller de 60s** (pull
   incremental por NSR — funciona mesmo sem IP fixo no lado do REP). ⚠️ Para o
   modo "REP empurra" de fato, exige **IP público fixo** na nuvem.

### 12.3 Correções já aplicadas
| Item | Onde | O que foi feito |
|---|---|---|
| Idempotência do AFD | `schema_tenant.sql` | `afd` agora tem `id BIGINT AUTO_INCREMENT PRIMARY KEY` + **`UNIQUE KEY uq_afd (id_Equipamento, NSR)`**. Sem isso, `ON DUPLICATE KEY UPDATE` não disparava e duplicava marcações. |
| Tenants já criados | `schema_tenant.sql` | Documentado `ALTER TABLE afd ADD COLUMN id BIGINT AUTO_INCREMENT PRIMARY KEY FIRST, ADD UNIQUE KEY uq_afd (id_Equipamento, NSR);` (rodar após remover duplicados de `(id_Equipamento, NSR)`). |
| Carga do `.env` | `server.js` + `package.json` | **Bug oculto:** o código nunca carregava `.env` (sem `dotenv`/`--env-file`) → usava segredos fracos padrão. Adicionado `dotenv` e `import 'dotenv/config';` **como 1ª linha** de `server.js` (antes de `auth.js`, que lê `process.env` na carga). |
| Segredos fortes | `.env` | Criado localmente com `JWT_SECRET` e `IZCLOUD_ADMIN_KEY` de 48 chars aleatórios + senha MySQL forte. **`.env` está no `.gitignore` (não commitar).** |
| Proteção de arquivos | `.gitignore` | Criado: ignora `.env`, `node_modules/`, `data/afd/`. |
| Validação | local | `node --check` OK em `server/core/sync/repClient`; app sobe e `/api/health` → `{"status":"ok","multiTenant":true}`. |

### 12.4 Pendências conhecidas (não bloqueiam deploy básico)
- **UI web** — `public/index.html` (SPA vanilla, sem build, servida pelo Express):
   login split-screen + layout sidebar glassmorphism (design system inspirado no
   `pontoweb`: tokens Inter, gradiente azul→verde, blobs de fundo, `glass-card`,
   `btn-primary` pill, ícones SVG estilo lucide, `toast` e `modal` de confirmação).
   Telas: REPs (sondar/cadastrar/listar), Pessoas (enviar ao REP), AFD
   (sincronizar/exportar) e Usuários (multi-usuário por empresa). Antes era API-only.
- **TLS** — app escuta HTTP 3100 puro; em produção colocar atrás de proxy HTTPS.
- **Paginação de `get_afd`** — REPs com AFD muito grande podem estourar; tratar.
- **`baixarMarcacoes`** (usa `get_markings`, comando não documentado) — **removido**
  em 2026-08 (código morto/risco; não usado em nenhum fluxo).
- **MySQL não instalado na máquina local** — para rodar 100% local precisa de um
  MySQL 8 (pode ser o do `docker-compose.yml`).

### 12.5 Como subir em nuvem (servidor em definição)
Requisito crítico: **IP público fixo** para o REP apontar/empurrar.
- **Oracle Cloud Free** (recomendado): VM sempre-on + IP estático.
- **Railway**: só domínio, sem IP fixo → trava modo "REP empurra"; use só FCGI
  IP-direto.

Passos (resumo):
1. Provisionar VM com IP fixo; abrir portas `3306` (MySQL) e `3100` (API).
2. `docker-compose up --build -d` (sobe MySQL 8 + Node; `schema_core.sql` cria
   `izcloud_core` no volume). Definir `IDCLOUD_PASS`, `JWT_SECRET`,
   `IZCLOUD_ADMIN_KEY` **fortes** no `.env`/compose.
3. Criar 1º cliente: `POST /api/auth/register` com header `x-admin-key` (vide §8/§10).
4. Apontar cada REP via `REPCONFIG.exe` com o IP da VM (campo iDCloud).
5. Testar: `login` → `/api/reps/probe` → `/api/reps` → `/api/afd/sync`.

### 12.6 Ambiente local (referência)
- `npm install` (inclui `dotenv` agora).
- `.env` presente (segredos fortes); use `npm start` (carrega `.env` via
  `dotenv/config`). Para `node server.js` direto também funciona.
- Precisa de MySQL acessível em `IDCLOUD_HOST` para rotas de DB.

### 12.7 Multi-usuário e modo de conexão por REP (adicionado)
- **Multi-usuário por empresa**: além da conta da empresa (`izcloud_core.clientes`),
  cada tenant tem operadores em `izcloud_core.usuarios` (login global único, `nivel`
  `admin`/`operador`). Web login aceita ambos (JWT carrega `tipo`/`nivel`). Sistemas
  externos (Basic+`X-Client-DB`) só aceitam a conta da empresa. Gerenciamento via
  `GET/POST /api/auth/usuarios` e `DELETE /api/auth/usuarios/:id` (exige empresa ou
  admin). UI: aba **Usuários**.
- **Modo de conexão por REP** (`equipamentos.ModoConexao`):
  - `nuvem_puxa` (padrão): o poller de 60s **puxa** o AFD do REP via FCGI IP-direto.
  - `rep_empurra`: o poller **não puxa**; os dados chegam via `POST /api/afd/push`
    (idempotente). Requer que o REP aponte para a nuvem (IP fixo/Cloudflare, §13.5).
    A UI marca o REP com pill `rep_empurra` e o poller o ignora no pull.
- **Migrações p/ bancos já existentes** (rode no MySQL da nuvem):
  ```sql
  -- core (izcloud_core)
  CREATE TABLE usuarios (
    id_usuario INT AUTO_INCREMENT PRIMARY KEY,
    id_cliente INT NOT NULL, schema_name VARCHAR(64) NOT NULL,
    login VARCHAR(64) NOT NULL, senha_hash VARCHAR(255) NOT NULL,
    nome VARCHAR(120), nivel ENUM('admin','operador') DEFAULT 'operador',
    ativo BIT DEFAULT 1, criado_em DATETIME,
    UNIQUE KEY uq_usuario_login (login), KEY idx_cliente (id_cliente)
  );
  -- cada tenant (tenant_XXXX)
  ALTER TABLE equipamentos
    ADD COLUMN ModoConexao ENUM('nuvem_puxa','rep_empurra') DEFAULT 'nuvem_puxa';
  ```

---

## 13. Deploy no Railway (definido)

Decisão: subir no **Railway** a partir deste repo GitHub (Oracle Cloud Free foi
descartado — não conseguimos criar a conta). O Railway faz **auto-deploy a cada
`push` no `main`** (integração GitHub nativa, sem GitHub Actions).

### 13.1 Ressalva crítica (modo de integração)
O Railway fornece **domínio, mas NÃO IP fixo**. Portanto:
- ❌ **Modo "REP empurra"** (você aponta o IP do servidor no REP via `REPCONFIG.exe`)
  **não funciona** no Railway — o REP precisa de um IP fixo para apontar.
- ✅ **Modo FCGI IP-direto** funciona: o iZCloud **puxa** do REP a cada 60s
  (`poller` em `sync.js`). O REP deve ter IP alcançável a partir da nuvem e é
  cadastrado pelo **próprio IP dele** em `/api/reps/probe` (não o contrário).
- Se no futuro quiser o modo "REP empurra", migrar para VM com IP fixo
  (ex.: Oracle Cloud Free) — ver §12.5.

### 13.2 Passos
1. Railway → **New Project** → **Deploy from GitHub repo** →
   `machado3-lang/izcloud-conection`. Conecta e auto-deploya em cada push.
   - Se o Railway acusar **"git repo not found"**: é permissão do *GitHub App* do
     Railway, não o repo (que existe). No GitHub: avatar → Settings →
     **Integrations** → app **Railway** → **Repository access** → marque
     `izcloud-conection` (ou *All repositories*) → Save. Depois reconecte o repo
     no Railway. Repo privado exige esse acesso; repo público basta reconectar.
2. **Add a MySQL**: no projeto, adicione um serviço **Database → MySQL**.
   Anote host/porta/usuário/senha (Railway expõe como `DATABASE_URL` ou variáveis
   `MYSQL_*`).
3. No serviço **iZCloud**, defina as env vars (mapeando do MySQL do Railway):
   - `IDCLOUD_HOST` = host do MySQL do Railway
   - `IDCLOUD_PORT` = porta do MySQL do Railway
   - `IDCLOUD_USER` = usuário do MySQL do Railway
   - `IDCLOUD_PASS` = senha **forte** do MySQL do Railway
   - `CORE_DB` = `izcloud_core`
   - `JWT_SECRET` = segredo forte (gerado)
   - `IZCLOUD_ADMIN_KEY` = chave de setup forte
   - `PORT` = `3100` (Railway injeta `PORT`; o app usa `process.env.PORT || 3100`)
4. O `schema_core.sql` cria `izcloud_core` se o Railway rodar o init; caso
   contrário crie manualmente (`mysql ... < schema_core.sql`). Os **tenants** são
   criados via `POST /api/auth/register` (ver §8/§10).
5. A URL gerada pelo Railway (ex.: `https://izcloud-xxxx.up.railway.app`) é a
   base da API. Use em `login`/`register`/etc.

### 13.3 Observações
- O app lê `process.env` (Railway injeta); o `.env` do repo é **ignorado** — não
  commitar segredos.
- `railway.toml` fixa o `Dockerfile` e o healthcheck em `/api/health`.
- Para testar o fluxo: `login` → `/api/reps/probe` (IP do REP alcançável) →
  `/api/reps` → `/api/afd/sync`.

### 13.4 URL de produção e verificação
- URL gerada (exemplo): `https://izcloud-conection-production.up.railway.app`
- **`GET /`** serve a **UI web** (SPA em `public/index.html`): login + telas de
  REPs, Pessoas e AFD. Antes dava "Cannot GET /" (sem rota raiz).
- **Healthcheck:** `GET /api/health` → `{"status":"ok","service":"iZCloud",
  "multiTenant":true}` (usado pelo `railway.toml`).
- Teste rápido:
  ```
  curl https://izcloud-conection-production.up.railway.app/api/health
  ```

### 13.5 IP fixo na frente do Railway (via Cloudflare) — modo "REP empurra"
O Railway só dá domínio, sem IP fixo, então o REP **não consegue apontar** para
ele via `REPCONFIG.exe` (precisa de IP). Plano: colocar o **Cloudflare** à frente
da URL do Railway para expor um **IP fixo** (TCP) que o REP aponta.
- O REP fala FCGI **HTTPS na porta 443**; precisa de um IP estático que encaminhe
  TCP 443 → URL do Railway.
- Opção viável: **Cloudflare Spectrum** (IPs estáticos para TCP por porta) —
  criar um Spectrum app apontando para `izcloud-conection-production.up.railway.app:443`.
  (Cloudflare Tunnel/`cloudflared` dá domínio, não IP fixo — insuficiente sozinho
  para o REP, que exige IP.)
- Após o IP fixo do Cloudflare, use-o no `REPCONFIG.exe` (campo iDCloud) em vez
  do domínio do Railway.
- **Sem IP fixo**, continue no modo **FCGI IP-direto** (iZCloud puxa do REP a
  cada 60s): cadastre o REP pelo IP dele em `/api/reps/probe`.


