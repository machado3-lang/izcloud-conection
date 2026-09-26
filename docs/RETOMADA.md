# iZCloud — Estado e retomada

> **Este arquivo é o índice único para retomar o projeto.**
> Snapshot de **25/09/2026**. Detalhes técnicos por completo no [`../README.md`](../README.md).

---

## 1. Qual projeto continuar (entre os 3 de `C:\Producao`)

Investigação feita em 25/09/2026. Os três diretórios com finalidade parecida
são, na verdade, **três coisas diferentes**:

| Diretório | Última edição | É projeto seu? | Veredito |
|---|---|---|---|
| **`C:\Producao\iZCloud`** | **17/08/2026** | ✅ Sim | **CONTINUAR AQUI** |
| `C:\Producao\Gerenciador REPs` | 01/08/2026 (subpasta `opencode`) | ❌ Quase não | Ferramentas oficiais da ControlID + esqueleto .NET abandonado |
| `C:\Producao\idacessoweb` | 23/05/2026 | ✅ Sim (antigo) | Projeto de **outro escopo** (facial), parado há ~4 meses |

### 1.1 Por que os outros dois não são o caminho

**`Gerenciador REPs`** — Apesar do nome, **não é um projeto para desenvolver**. Contém:
- `REPCONFIG.exe` (17/05/2026) e `AFD Downloader/` → **binários oficiais da ControlID**
  (datas de 2024/2025, com assinatura `CodeSigning2017.pfx`). Ferramentas de apoio.
- `app_idface.py` (24/04/2026) → script solto, esquecido.
- `opencode/` → tentativa de **reescrita em .NET 6 / EF Core / MediatR / PostgreSQL**,
  abandonada em 01/08/2026. Só tem `HealthController`; o `documento.md` dita um
  "100% pronto para produção" que **não corresponde ao código**.
  O próprio README do iZCloud (§12.1) registra: *"é um esqueleto incompleto e
  separado — não deve ser usado."*

**`idacessoweb` (MultiAcesso v1.0.0)** — Escopo **diferente**: controle de acesso
**facial iDFace** (porta, bloqueio, foto facial, ações remotas), **não** ponto/REP.
- Stack: React 19 + Vite (`face-web`) + Express (`face-cloud`), **banco em arquivo JSON**.
- Sem git, sem deploy, sem multi-tenant, sem AFD, sem biometria de dedo.
- Documentado e "completo" (490 linhas de `DOCUMENTACAO.md`) mas com ~15 pendências
  listadas (Supabase, multi-usuário, WebSocket, deploy...).

**Decisão:** manter `idacessoweb` arquivado. Se um dia o controle de acesso facial
voltar à pauta, ele serve de referência de **UI** (o design glassmorphism do iZCloud
copiou o `pontoweb`, que é da mesma família).

---

## 2. Onde o iZCloud parou

Último commit: `6d96eb0` — *"docs: relato da sessao de retomada — correcao do login
na Railway (502/MySQL)"*, 17/08/2026. Árvore limpa, 12 commits, sincronizado com
`origin/main` (`github.com/machado3-lang/izcloud-conection`).

**O que foi resolvido na última sessão:** o `502` no login. Causa raiz: as env vars
do serviço na Railway apontavam `IDCLOUD_HOST=localhost` (o próprio app) em vez do
MySQL. Corrigido + `core.js` ganhou timeouts, `pool.on('error')` e auto-init
idempotente do `izcloud_core`; `server.js` ganhou `GET /api/health/db`.
Resultado verificado: `{"ok":true,"tabela_contas":true,"erro":null}`.

**Onde parou de fato:** no passo logo em seguida — **criar a conta e fazer o primeiro
login**. O backend está de pé, mas **ninguém jamais entrou na plataforma**.

---

## 3. Pendências priorizadas

### P0 — desbloqueia o uso da plataforma
1. **Criar a conta do primeiro cliente** e validar o login ponta a ponta.
   ```bash
   curl https://izcloud-conection-production.up.railway.app/api/auth/registro \
     -H "Content-Type: application/json" \
     -d '{"login":"admin","senha":"<forte>","nome":"Antonio"}'
   ```
   Depois `POST /api/auth/login` com as mesmas credenciais → `token` + lista de empresas.
   (Detalhe no README §12.12.1.)

### P1 — segurança (não bloqueia o uso, mas bloqueia produção)
2. **Trocar os segredos placeholder na Railway.** `JWT_SECRET` e `IZCLOUD_ADMIN_KEY`
   ainda são os valores de exemplo do README. Gerar com `openssl rand -hex 32`.
   `IZCLOUD_ADMIN_KEY` protege `POST /api/auth/register`.

### P2 — o blocker de arquitetura (ver [`IP-FIXO.md`](IP-FIXO.md))
3. **IP público fixo** para o REP apontar para a nuvem (modo `rep_empurra`).
   O Railway **não entrega IP fixo**. Análise de opções e plano em
   [`docs/IP-FIXO.md`](IP-FIXO.md) — **leia antes de decidir**.
4. **TLS/HTTPS**: o app escuta HTTP puro na 3100. Um REP exigindo HTTPS na 443
   não conecta hoje. Resolvido de passagem pela opção 3 (VPS com Let's Encrypt).

### P3 — validação em hardware real
5. **Biometria no REP de homologação (192.168.100.132)** — os nomes de campo de
   template (`templates[].template/finger/type`, `facial[].faceTemplate`) e o envio
   em `add_users` **variam por firmware**. Ajustar `mapearUsuario`/`enviarUsuarios`
   conforme o REP devolver. O import/push não depende de MySQL para falar com o REP.
6. **Paginação de `get_afd`** — REPs com AFD muito grande.

### P4 — robustez / operação
7. **Backup por tenant**: `mysqldump <schema>` de cada `tenant_XXXX`.
8. **Edição/remoção de funcionário** — hoje a API só faz inserção.
9. Migrações de banco ainda **não aplicadas** em ambientes existentes — o SQL está
   no README §12.11 ("Migrações obrigatórias").

---

## 4. Estado do banco (o que já existe / o que falta)

O `inicializarCore()` cria **apenas o core** (`izcloud_core` + tabelas `contas`/
`clientes`/`usuarios`) na subida do app. **Não** cria tenants nem `templates` nos
tenants já existentes.

| Onde | O que precisa | Já existe? |
|---|---|---|
| `izcloud_core` | `contas`, `clientes`, `usuarios` | ✅ criado pelo auto-init |
| cada `tenant_XXXX` | `equipamentos.ModoConexao` | ❌ migrar |
| cada `tenant_XXXX` | `templates` (biometria) | ❌ migrar |
| cada `tenant_XXXX` | `afd` com `UNIQUE(id_Equipamento, NSR)` | ❌ migrar |

SQL pronto no README §12.11.

---

## 5. Mapa dos arquivos (o que mexer em cada tarefa)

| Tarefa | Arquivo |
|---|---|
| Cliente FCGI do REP (login, probe, add_users, get_afd, biometria) | `repClient.js` |
| Leitura/escrita no schema da empresa | `idcloud.js` |
| Parser AFD 1510/671 + `gerarPorPeriodo` | `afd.js` |
| Sync incremental por NSR + poller de 60s | `sync.js` |
| Núcleo multi-tenant (pools, criação de cliente/empresa) | `core.js` |
| Login JWT, `authTenant`, `authConta`, Basic + `X-Client-DB` | `auth.js` |
| Rotas Express | `server.js` |
| UI (SPA vanilla, 52 KB, sem build) | `public/index.html` |
| Schema de contas | `schema_core.sql` |
| Schema de uma empresa | `schema_tenant.sql` |
| Testes contra REP real | `test_*.mjs` (IP 192.168.100.132) |

---

## 6. Como rodar local

```bash
cd C:\Producao\iZCloud
npm install
cp .env.example .env     # preencha IDCLOUD_* e PORT
npm start                # http://localhost:3100
```

Precisa de um MySQL 8 acessível em `IDCLOUD_HOST` (o `docker-compose.yml` do repo
sobe um). Sem MySQL o app **sobe** e serve `/api/health`, mas as rotas de dados
falham — foi proposital (commit `a79666c`, tolerância a falha de DB).

Diagnóstico rápido contra a Railway:
```bash
curl https://izcloud-conection-production.up.railway.app/api/health/db
```

---

## 7. Glossário (evita confusão)

| Termo | Significado |
|---|---|
| **iZCloud** | *nosso* sistema (este repo). Substitui o iDCloud pago da ControlID. |
| **iDCloud** | serviço **pago** da ControlID que estamos trocando. |
| **1510** | portaria/portaria-tipo do REP: documento = **PIS**, data `DDMMAAAA`+`HHMM`. |
| **671** | modelo mais novo: documento = **CPF**, data ISO `YYYY-MM-DDTHH:MM:SS`. |
| **`nuvem_puxa`** | modo de conexão: a **nuvem** puxa o AFD do REP (poller 60s). Padrão. |
| **`rep_empurra`** | modo de conexão: o **REP** empurra o AFD para a nuvem (`/api/afd/push`). |
| **FCGI** | protocolo HTTP-ish (`.fcgi`) que o iDClass expõe; HTTPS 443 com fallback HTTP 80. |
| **tenant** | 1 schema MySQL = 1 **empresa**. `tenant_0001`, `tenant_0002`... |
| **conta** | o login do cliente (`izcloud_core.contas`); pode ter N empresas. |
| **REP** | relógio de ponto ControlID iDClass. |

⚠️ `nuvem_puxa` **também** exige caminho de rede — a nuvem precisa **alcançar** o
REP. Ver [`IP-FIXO.md`](IP-FIXO.md) §2: não basta ter IP fixo na nuvem.
