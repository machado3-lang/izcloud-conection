# Administração do iZCloud — criação de contas

> **Estado: implementado (2026-09-26).** O painel existe em **`/admin.html`**,
> com banco, API, tela e auditoria. As seções 1–2 descrevem o modelo e o
> fallback por `curl`; a seção 3 descreve o que foi construído.
>
> ```bash
> # 1. defina na Railway (o app cria/promove a conta no boot)
> IZCLOUD_ADMIN_LOGIN=admin
> IZCLOUD_ADMIN_SENHA=<senha forte de 8+>
> # 2. redeploy e entre em https://<seu-dominio>/admin.html
> ```

---

## 1. Modelo de acesso

```
IZCLOUD (plataforma)
└── conta            izcloud_core.contas      -> login web (dono do cliente)
    │                 papel = 'admin'   -> administrador da plataforma
    │                 papel = 'cliente' -> cliente normal
    ├── empresa      izcloud_core.clientes    -> tenant_XXXX (schema próprio)
    │                 login/senha = credencial de API externa (Secullum)
    │                 + perfil (razão social, CNPJ, endereço, responsável)
    └── operador     izcloud_core.usuarios    -> login web de uma empresa
                                                  (nível admin | operador)
```

- **Conta** (`contas`): quem contrata o iZCloud. Faz login na web e pode ter
  **várias empresas** (filiais). Cada empresa é um schema MySQL isolado.
- **Operador** (`usuarios`): login de uma empresa específica. Faz login na web e
  cai direto na empresa dele (o token já carrega a empresa, sem `X-Empresa`).
- **Credencial de API** (`clientes.login`): é o par usuário/senha que sistemas
  externos (Secullum) usam com `Authorization: Basic` +
  `X-Client-DB: tenant_XXXX`. Não serve para login web.
- **Administrador da plataforma** (`contas.papel = 'admin'`): cria contas, vê
  **todas** as empresas, desativa/reativa, reseta senha. Entra em `/admin.html`.
  Não acessa os dados de ponto das empresas — para isso entra como o cliente.

---

## 2. Criar contas sem o painel (fallback / emergência)

O painel é o caminho normal. Se algo impedir o acesso a ele, use a
`IZCLOUD_ADMIN_KEY` por `curl` (§2.1). Ela protege estas rotas:

| Método | Rota | Para que serve |
|---|---|---|
| POST | `/api/auth/registro` | cria conta (+ 1ª empresa) |
| POST | `/api/auth/register` | cria empresa para um `id_conta` existente |
| GET | `/api/auth/clientes` | lista todas as empresas da plataforma |
| GET | `/api/health/db` | diagnóstico completo do MySQL |

### 2.1 Criar a conta do cliente (e a 1ª empresa)

```bash
curl -X POST https://izcloud-conection-production.up.railway.app/api/auth/registro \
  -H "x-admin-key: $IZCLOUD_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "login": "cliente1",
    "senha": "SENHA_FORTE_8+",
    "nome": "João da Silva",
    "empresa": {
      "login": "empresa1",
      "senha": "OUTRA_SENHA_FORTE",
      "razao_social": "Empresa 1 LTDA",
      "cnpj": "12345678000100",
      "responsavel_nome": "João da Silva",
      "responsavel_cpf": "12345678909"
    }
  }'
```

Resposta: `{ "token": "...", "contas": [ { "schema": "tenant_0001", ... } ] }`

Regras: `login` de 3–64 caracteres (`[A-Za-z0-9._-]`), senha de 8–200 caracteres.

### 2.2 Criar operadores de uma empresa

O dono da conta (ou um operador `admin`) cria usuários no painel do cliente, na
aba **Usuários**. Equivalente por API:

```bash
curl -X POST https://izcloud-conection-production.up.railway.app/api/auth/usuarios \
  -H "Authorization: Bearer $TOKEN_DA_CONTA" \
  -H "X-Empresa: tenant_0001" \
  -H "Content-Type: application/json" \
  -d '{"login":"operador1","senha":"SENHA_FORTE_8+","nome":"Maria","nivel":"operador"}'
```

### 2.3 Rotas de diagnóstico (públicas, sem segredo)

| Método | Rota | O que devolve |
|---|---|---|
| GET | `/api/health` | `{"status":"ok"}` — usado pelo healthcheck da Railway |
| GET | `/api/health/status` | `{ok, tabela_contas, colunas_ok, faltando, erro}` — o MySQL responde? O esquema está em dia? |
| GET | `/api/config` | `{signup_aberta}` — a UI usa para esconder o cadastro |

> **`faltando` é o diagnóstico mais útil em caso de login quebrado.** Se
> `colunas_ok` for `false`, a lista mostra exatamente quais colunas faltam —
> o app cria sozinho no boot seguinte, mas enquanto não criar, o login responde
> **503** (o `SELECT` na coluna inexistente estoura `ER_BAD_FIELD_ERROR`).
> Erro de senha de verdade responde **401**.

---

## 3. O painel de administrador (`/admin.html`)

### 3.1 Banco de dados

```sql
-- papel: 'admin' = administrador da plataforma; 'cliente' = cliente normal
ALTER TABLE contas
  ADD COLUMN papel ENUM('admin','cliente') NOT NULL DEFAULT 'cliente',
  ADD COLUMN ultimo_login DATETIME,
  ADD COLUMN criado_por INT;

CREATE TABLE IF NOT EXISTS admin_auditoria (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_conta   INT,                            -- admin que executou
  acao       VARCHAR(40) NOT NULL,
  alvo       VARCHAR(120),
  detalhes   TEXT,
  ip         VARCHAR(45),
  criado_em  DATETIME,
  KEY idx_conta (id_conta),
  KEY idx_data (criado_em)
);
```

**Não rode isso à mão.** `inicializarCore()` (core.js) aplica tudo de forma
idempotente na subida do app: roda o DDL de `schema_core.sql` e depois
`aplicarMigracoes()`, que confere `information_schema.COLUMNS` antes de cada
`ALTER` (MySQL não tem `ADD COLUMN IF NOT EXISTS`).

O primeiro admin vem das env vars `IZCLOUD_ADMIN_LOGIN` /
`IZCLOUD_ADMIN_SENHA`: se a conta não existe, é criada com `papel = 'admin'`; se
existe, é promovida.

### 3.2 API

Todas as rotas usam o middleware **`authAdmin`** (`auth.js`): exige JWT de
**conta** e lê `contas.papel` do **banco a cada requisição** — o papel não vem do
token, então rebaixar ou desativar um admin tem efeito imediato, sem esperar o
token expirar. Um administrador também **não** ganha acesso aos dados de ponto
das empresas: `authTenant` continua exigindo `X-Empresa` de uma empresa da
própria conta.

| Método | Rota | Função |
|---|---|---|
| GET | `/api/admin/panorama` | tudo de uma vez: contas, empresas, auditoria, totais |
| GET | `/api/admin/contas` | contas + nº de empresas + status |
| POST | `/api/admin/contas` | cria conta (`{login, senha, nome, empresas: [...]}`) |
| PUT | `/api/admin/contas/:id` | edita `nome` / `papel` / `ativo` |
| POST | `/api/admin/contas/:id/senha` | reseta a senha |
| GET | `/api/admin/contas/:id/empresas` | empresas da conta |
| POST | `/api/admin/contas/:id/empresas` | adiciona empresa a uma conta |
| GET | `/api/admin/empresas` | empresas de todos os clientes |
| PUT | `/api/admin/empresas/:id` | edita o perfil / desativa |
| GET | `/api/admin/auditoria?limite=100` | log de ações (máx. 500) |

Proteções em `core.js`:

- O admin **não pode** alterar o próprio `papel` nem desativar a própria conta.
- A plataforma **não pode** ficar sem admin ativo (`contarAdminsAtivos()`).
- **Nada é apagado** — só desativado. O schema `tenant_XXXX` e os dados de ponto
  ficam preservados para recuperação.
- Toda ação do admin vira uma linha em `admin_auditoria` (com o IP).

### 3.3 Tela

`public/admin.html` — mesma identidade visual do painel (tokens do design
system, glassmorphism, toasts, modal de confirmação). O item **Administração**
só aparece na barra lateral de `index.html` quando `perfil.papel === 'admin'`.

Três abas:

- **Contas** — login, nome, papel, nº de empresas (com os `schema`), status,
  último login. Ações: *Editar* (nome/papel), *Senha* (reset), *+ Empresa*,
  *Desativar* / *Ativar*.
- **Empresas** — todas as empresas: razão social, CNPJ, `schema` ("número do
  banco"), login externo, conta dona, status. Ações: *Editar*, *Desativar*.
- **Auditoria** — as últimas ações do administrador.

Indicadores no topo: total de contas, contas ativas, empresas, empresas ativas.
O botão **Gerar senha** cria uma senha forte para entregar ao cliente.

### 3.4 Testes

Três suítes, todas sem MySQL (diretórios `.tmp-*`, ignorados pelo git e pelo
Docker):

| Suíte | O que cobre |
|---|---|
| `.tmp-authtest/test.mjs` | o bypass de login, rate limit, validações, token forjado |
| `.tmp-admintest/test.mjs` | `authAdmin`: quem entra, quem não, efeito imediato do rebaixamento |
| `.tmp-e2e/test.mjs` | **o app real contra um driver MySQL falso**: bootstrap, criar conta + empresa, isolamento cliente/admin, validações, reset de senha, desativar, proteção do último admin, auditoria, telas |

```bash
Copy-Item auth.js .tmp-authtest\auth.js -Force; node .tmp-authtest\test.mjs
Copy-Item auth.js .tmp-admintest\auth.js -Force; node .tmp-admintest\test.mjs
node .tmp-e2e\test.mjs
```

> O `.tmp-e2e` copia o app para `.tmp-e2e/app` e injeta um `mysql2/promise.js`
> falso. Ele valida a **lógica** (SQL, wiring, regras), **não** a sintaxe SQL
> contra um MySQL real — a primeira validação de verdade é o deploy.

---

## 4. Checklist de segurança (rodar a cada deploy)

- [ ] `JWT_SECRET` e `IZCLOUD_ADMIN_KEY` com 32+ caracteres, diferentes dos
      exemplos do README. O app acusa no log (`[auth] CRITICO`) se não estiver.
- [ ] `IZCLOUD_SIGNUP_ABERTA=false`.
- [ ] `IZCLOUD_ADMIN_LOGIN` / `IZCLOUD_ADMIN_SENHA` definidos, e a senha do
      admin trocada depois do primeiro acesso.
- [ ] `GET /api/health/status` → `ok: true` **e `colunas_ok: true`** (com
      `faltando: []`).
- [ ] `GET /api/health/db` responde 401/403 sem `x-admin-key`.
- [ ] `POST /api/auth/registro` responde 403 sem `x-admin-key`.
- [ ] `POST /api/auth/login` com senha errada responde **401**, nunca 200.
- [ ] `GET /api/admin/panorama` responde 401 sem token e 403 com token de cliente.
- [ ] Rotas com `X-Empresa: tenant_9999` (de outra conta) respondem 403.
