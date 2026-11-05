# iDFace — o que já temos e o que reaproveitar

> Análise feita em 04/11/2026 das pastas `C:\Producao\idacessoweb` e
> `C:\Producao\controle-de-acessos`. O objetivo é aproveitar o que já existe
> para a linha **iDFace** no iZCloud, sem repetir trabalho.

## 1. O que são as duas pastas

| Pasta | Data | O que é |
|---|---|---|
| `idacessoweb` | 08/07/2026 | Protótipo MultiAcesso: `face-cloud` (Express) + `face-web` (React/Vite). Backend em JSON local. |
| `controle-de-acessos` | 03/11/2026 | Mesmo projeto, com README/Docker e repositório GitHub (`machado3-lang/controle-de-acessos`). É a versão mais nova. |

As duas têm a mesma base. A diferença prática mais importante:

- **`idacessoweb` tem upload de foto facial binário** (`proxyBinary`, envia a
  imagem com `Content-Type` correto).
- **`controle-de-acessos` removeu esse upload binário** e passou a mandar
  `image_data` como JSON — provavelmente uma regressão. Para foto facial, usar a
  versão do `idacessoweb`.

## 2. O que já funciona e pode ser reaproveitado

### 2.1 Proxy FCGI do iDFace (`face-cloud/server.js`)

O backend tem um cliente HTTP/HTTPS que fala `.fcgi` com o equipamento. É a
parte mais valiosa e pode virar um módulo `idfaceClient.js` no iZCloud:

- `proxyFCGI(protocol, ip, porta, command, data)` com fallback HTTPS → HTTP.
- `login` (`login.fcgi`) → `session`.
- `load_objects?session=...` com `object: 'users'` e `object: 'access_logs'`.
- `create_objects`, `modify_objects`, `destroy_objects` para usuários.
- `user_set_image` para foto facial (usar a versão binária do `idacessoweb`).
- `set_configuration` (inclui o bloco `push_server`).
- `get_system_info` e `get_configuration`.
- `execute_actions` (abrir porta), `set_configuration` (lock/unlock) e `reboot`.

Endpoints Express correspondentes (podem virar funções internas, sem expor
proxy aberto):

- `POST /api/proxy/login`
- `POST /api/proxy/users/load`
- `POST /api/proxy/users/create`
- `POST /api/proxy/users/modify`
- `POST /api/proxy/users/destroy`
- `POST /api/proxy/face/upload`
- `POST /api/proxy/logs`
- `POST /api/proxy/info`
- `POST /api/proxy/config`
- `POST /api/proxy/action`

### 2.2 Configuração do push no equipamento (`face-web/src/api.js`)

O `configurePush` monta exatamente o bloco que o iDFace espera:

```json
{
  "push_server": {
    "push_remote_address": "https://seu-servidor/api/idface/push",
    "push_request_timeout": "30000",
    "push_request_period": "5",
    "push_attributes": "serial=SEU_SERIAL"
  }
}
```

Isso é reutilizável quase como está. O `push_remote_address` aceita URL
(domínio), então a Railway serve para o iDFace — diferente do REP iDClass.

> **Atenção (medido no iDFace 6.26.4 em 05/11/2026):** esse firmware **não tem
> o campo `push_attributes`**. Enviar `push_attributes: serial=...` faz o
> `set_configuration` retornar erro. Use só `push_remote_address`,
> `push_request_timeout` e `push_request_period`.

### 2.3 CRUD e modelos simples

- Dispositivo: nome, IP, porta, serial, usuário, senha, descrição.
- Usuário: `id` numérico, `name`, `registration`.
- Log de acesso: data/hora, `user_id`, nome, status.
- Config: URL/token do push server.

Serve como referência de campos, mas o iZCloud deve usar MySQL/multi-tenant,
não JSON/localStorage.

### 2.4 UI

As abas (Dashboard, Equipamentos, Usuários, Logs, Relatórios, Acesso Remoto)
servem de referência de fluxo. O iZCloud é SPA vanilla; não dá para copiar os
componentes React diretamente, mas as ideias de tela são úteis.

### 2.5 Projeto irmão `sistema-de-pontos` (referência extra)

O `C:\Producao\sistema-de-pontos` é o MultiPonto, mais novo e mais completo.
Tem duas coisas que valem olhar:

- **`ponto-cloud/push-store.js` + migration `006_push_persistencia.sql`**:
  persistência do push em PostgreSQL (`push_devices`, `push_events`,
  `push_results`, `push_commands`, `push_marcacoes`) com write-through e
  recarga no boot. É um bom desenho de fila/telemetria para portar ao MySQL.
- **`server.js` §"Proxy iDFace"**: um gerador de AFD a partir de `access_logs`
  do iDFace (header tipo 1 + marcações tipo 3 + trailer tipo 9), detecção de
  modo ponto/`attendance_mode` e mapeamento `user_id -> PIS/CPF`.

Ressalvas: o push dele usa o mesmo formato não oficial do `face-cloud`
(`transactions[].id/method/url/body`), e o gerador de AFD do iDFace **não foi
validado** (não calcula CRC e não gera o registro tipo 2 do empregador). Serve
de ponto de partida, não de implementação final.

Também existe `rep-relay.js` + `IZCLOUD_INTEGRACAO.md` definindo um contrato
`POST /relay` para o MultiPonto alcançar REPs na LAN via iZCloud. Não é iDFace,
mas é uma integração útil para o ecossistema (o iZCloud ainda não implementa
esse `/relay`).

## 3. O que NÃO reaproveitar / o que está faltando

### 3.1 Protocolo de push

O `face-cloud` implementa um push **não oficial**:

```json
{ "transactions": [ { "id": "...", "method": "POST", "url": "/...", "body": {} } ] }
```

O iDFace oficial usa (docs/PROTOCOLOS.md §2.1):

- `GET /push?deviceId=<int64>&uuid=<string>` → vazio ou
  `{ "verb": "...", "endpoint": "...", "body": {}, "contentType": "..." }`.
- Lote: `{ "transactions": [ { "transactionid": "...", "verb": "...",
  "endpoint": "...", "body": {}, "contentType": "..." } ] }`.
- `POST /result?deviceId=&uuid=` com `{ "response": ... }` ou `{ "error": ... }`.
- Eventos são separados no **Monitor** (`/api/notifications/*`), não
  necessariamente no corpo do `/push`.

O formato do `face-cloud` provavelmente não é executado pelo iDFace. O iZCloud
deve implementar o formato oficial.

### 3.2 Autenticação do dispositivo

O `face-cloud` identifica o dispositivo por `X-Device-Serial`, `serial` na
query, `X-Device-ID`, `device_id` ou IP. Não lê `deviceId`/`uuid` do protocolo
oficial, não valida um código e não persiste o vínculo com empresa/equipamento.

O iDCloud oficial da Control iD usa um **código interno (código iDCloud)** junto
com o serial no caso do REP. Importante: no REP iDClass esse código é o
**número curto** (ex.: `123`) cadastrado como usuário no aparelho; ele é
controle interno, não um segredo que o REP apresenta. Quem identifica o REP é
o `nSerie` no `get_about`.

Para o iDFace, o push usa `deviceId` + `uuid` e o `push_attributes` pode
carregar o serial. **Precisamos medir no equipamento real** o que ele envia
(query, headers e corpo) para decidir o vínculo e a autenticação:

- `deviceId` / `uuid` / serial;
- `push_attributes` (ex.: `serial=...`);
- headers (`X-Device-Serial`, etc.);
- se há código/token no primeiro contato.

### 3.3 Banco, multi-tenant e persistência

O `face-cloud` usa `database.json` e `localStorage`. O iZCloud já tem
MySQL/multi-tenant; o iDFace deve entrar no mesmo modelo:

- `equipamentos` com um campo de linha/modelo (`idface`/`idclass`);
- `idface_devices`/`idface_comandos`/`idface_eventos` (ou tabelas equivalentes)
  no schema do tenant;
- fila de comandos por dispositivo, persistida.

### 3.4 AFD

O `face-cloud` **não gera AFD**: ele carrega `access_logs` e exporta CSV/HTML.
O iZCloud já tem parser/gerador de AFD 1510/671 (`afd.js`) e importação manual.

Caminhos possíveis, a validar no iDFace real:

1. O próprio iDFace gera o AFD (antigo/PIS ou novo/CPF) e o iZCloud importa o
   arquivo (já implementado na aba AFD).
2. Se existir um endpoint de relatório/AFD (`report_generate.fcgi` ou similar),
   o `idfaceClient` chama e importa.
3. Se só houver `access_logs`, guardamos os logs para relatório; **não** tentar
   sintetizar AFD sem conhecer o CRC/layout exato.

### 3.5 Frontend do projeto antigo

- O botão "conectar" só grava no `localStorage`; não chama o proxy.
- O upload de foto na UI não chama a API.
- `api.logs.list()` no front espera array, mas o backend devolve
  `{ total, logs }` — incompatível.
- Token `face-cloud-token-2024` fixo no código.

São protótipos; não usar como base de produção.

## 4. Proposta de integração no iZCloud

1. **`idfaceClient.js`** — porta o proxy FCGI e as operações (login, users,
   foto, logs, config, ações), com timeouts e fallback HTTPS → HTTP.
2. **Cadastro do iDFace** — equipamento com `Linha = idface`, serial, IP/porta e
   `REPType` (`1510` = PIS, `671` = CPF). Empresa sempre manual (iDFace não tem
   `load_company`).
3. **Servidor Push oficial** — rotas `/api/idface/push`, `/result` e Monitor,
   com fila persistida e formato oficial `{verb, endpoint, body, contentType}`.
4. **Vínculo do dispositivo** — primeiro contato grava serial/deviceId/uuid/IP
   como "pendente"; o admin vincula à empresa/equipamento e gera/valida o
   token/código do dispositivo. Medir antes o que o iDFace envia.
5. **Importar/enviar funcionários** — `load_objects users` para importar;
   `create_objects`/`modify_objects`/`destroy_objects` + `user_set_image` para
   enviar. Reaproveitar o upload binário do `idacessoweb`.
6. **AFD** — manter a importação manual (já feita) e, se o equipamento tiver
   endpoint de AFD, automatizar a coleta. Sem endpoint, guardar `access_logs`
   para relatório e usar o AFD gerado pelo próprio iDFace.
7. **UI** — nova aba/linha "iDFace" com status do push, dispositivos vistos,
   comandos pendentes, logs e importação de AFD. As telas do `face-web` servem
   de referência, mas o código é React e o iZCloud é vanilla.

## 5. Validação com o iDFace real

Script pronto: `test_idface.mjs` (somente leitura).

```bash
node test_idface.mjs 192.168.0.50
# ou
IDFACE_IP=192.168.0.50 IDFACE_PORT=80 node test_idface.mjs
```

Ele tenta HTTPS e HTTP, faz login (`admin/admin` por padrão), lê
`get_system_info`, `get_configuration`, `load_objects` (`users` e
`access_logs`) e mostra um resumo. **Não altera nada.**

Depois, com autorização, a segunda etapa é:

1. configurar `push_server` apontando para um endpoint de teste nosso
   (`push_remote_address`, `push_request_period=5`, `push_attributes=serial=...`);
2. capturar o que o iDFace envia no `/push` (método, query, headers, corpo);
3. testar um comando inofensivo no formato oficial e ver o `/result`;
4. testar a geração/exportação de AFD (PIS e CPF);
5. reverter a configuração se necessário.

## 6. Perguntas para fechar o desenho

1. O iDFace real está em qual IP/porta? Podemos rodar o `test_idface.mjs`?
2. Podemos alterar temporariamente o `push_server` dele para um endpoint nosso
   e depois reverter?
3. O AFD do iDFace será gerado pelo próprio equipamento (importação manual) ou
   você quer que o iZCloud colete `access_logs` e monte o AFD?
4. O vínculo do iDFace deve ser por serial, `deviceId`/`uuid` ou por um código
   iDCloud (como no REP)? Precisamos medir o primeiro contato para decidir.

## 7. Medição no iDFace real (05/11/2026)

Equipamento: **192.168.100.138:80**, `admin/admin`, modelo iDFace, firmware
**6.26.4**.

| Campo | Valor |
|---|---|
| Serial | `0M0200/02506F` |
| `device_id` | `4408801109364847` |
| **`iDCloud_code`** | **`34987342`** |
| Modo | **Ponto** (`general.attendance_mode = "1"`) |
| Usuários | 65 |
| `access_logs` | 0 (sem marcações) |
| SSL do web server | desligado (porta 80) |

### 7.1 Configuração de push/monitor atual

```json
{
  "push_server": {
    "push_remote_address": "https://push-rhid.idsecure.com.br/api",
    "push_request_timeout": "60000",
    "push_request_period": "300"
  },
  "monitor": {
    "hostname": "https://push-rhid.idsecure.com.br",
    "port": "443",
    "path": "api/notifications",
    "request_timeout": "5000",
    "alive_interval": "30000"
  }
}
```

Para ler a configuração, o payload do `get_configuration` é um objeto com
arrays de campos:

```json
{ "general": ["attendance_mode"], "push_server": ["push_remote_address"], "monitor": ["hostname"] }
```

**Não** envie `push_attributes` neste firmware (não existe).

### 7.2 AFD

A tela `/reports/afd` usa:

- **595 (PIS/1510-like):** `POST /export_afd.fcgi?session=...` (sem `mode`)
- **671 (CPF):** `POST /export_afd.fcgi?session=...&mode=671`

Corpo: `{}` (integral), `{ initial_nsr: N }` ou
`{ initial_date: { day, month, year } }`. A resposta é `text/plain`.

**Com 2 marcações reais (05/11/2026):**

| Modo | Bytes | Linhas | Batidas |
|---|---|---|---|
| 595 (PIS) | 475 | 5 | 2 |
| 671 (CPF) | 574 | 5 | 2 |

Linhas reais:

```text
595: 00000000130511202610200701756811724A72
671: 00000000132026-11-05T10:20:00-0400070175681172ADB4
```

O documento é o **`id` do usuário** (`70175681172`), não a `registration`
(`02613449424`). No 671 o iDFace manda **12 dígitos** (`070175681172`) antes do
CRC — o parser antigo lia `07017568117` e perdia o último dígito. `afd.js`
ganhou `extrairDocumento()` e `test/afd.test.mjs` cobre as duas linhas.

O AFD do iDFace **não tem tipo 2 (empregador) nem tipo 5 (empregados)**: tem
cabeçalho tipo 1, marcações tipo 3 e a linha de trailer `999999999...9`. O
empregador/CEI continua sendo cadastro manual no iZCloud.

**Onde ficam PIS/CPF no iDFace (medido em 05/11/2026):**

| Dado | Onde |
|---|---|
| PIS | `users.registration` (`02613449424`) |
| CPF | `c_users.cpf` (`19373613065`, campo customizado) |
| ID do usuário | `users.id` (`70175681172`, gerado pelo equipamento) |

O relatório AFD usa **`users.id`** nos dois formatos; ele **não junta**
`users.registration` nem `c_users.cpf`. Por isso o 595 e o 671 saem com o mesmo
documento. A diferença é só de layout.

**Resolvido em 05/11/2026 com o teste no RHiD da Control iD.** O comparativo
completo está em [`RHID-COMPARATIVO.md`](RHID-COMPARATIVO.md). Em resumo:

- O RHiD **apagou** o usuário antigo (`id=70175681172`) e **criou outro** com
  `id=2613449424` (= PIS `02613449424` sem o zero à esquerda). As marcações
  novas passaram a sair com PIS no AFD do equipamento.
- As 4 marcações antigas (com o `id` antigo) **não entraram** em nenhum arquivo
  fiscal do RHiD — ficaram órfãs. É o risco que o iZCloud precisa evitar.
- O RHiD **gera os fiscais na nuvem**: AFD 671 versão 004 (tipo 5 + tipo 7,
  CPF), AEJ 671 (CPF), AFDT 1510 (PIS) e ACJEF 1510 (PIS). O AFD do
  equipamento continua sendo só um coletor, sem valor legal.
- **Decisão:** o iZCloud não deve reescrever o AFD do equipamento. Deve coletar
  as marcações, versionar o vínculo `device_user_id` ↔ funcionário e gerar os
  arquivos fiscais na nuvem (ou entregar as marcações a um REP-P certificado).
  Provisionar `users.id` = PIS desde o início e nunca trocar depois.

### 7.3 Push validado (05/11/2026)

Com Cloudflare Quick Tunnel + capturador local:

```text
GET /push?deviceId=4408801109364847&uuid=4fa06cbe
-> comando single:
   {"verb":"POST","endpoint":"message_to_screen",
    "body":{"message":"Teste iZCloud","timeout":5000},"contentType":"application/json"}
POST /result?deviceId=4408801109364847&uuid=4fa06cbe&endpoint=message_to_screen
   {"response":"{}"}
```

O `uuid` muda a cada poll; **não é token**. O `deviceId` é estável. O push não
manda serial nem `iDCloud_code`. Recomendação: token por dispositivo no
**path** da URL (`/api/idface/<token>/push`) + `deviceId` + código iDCloud como
claim. O transporte HTTPS com domínio funciona (Cloudflare/Railway); não
precisa de IP fixo para o iDFace.

Também validamos dados via push:

- `load_objects` com `{object:'access_logs'}` → `/result` com os logs no
  `response` (JSON string).
- `export_afd` `{}` → `/result` com o **AFD 595 completo** (header + tipo 3 +
  trailer tipo 9).
- `export_afd` + `queryString:'mode=671'` → **AFD 671 completo**.
- **Não** colocar `?mode=671` no `endpoint`: o aparelho devolve a interface
  HTML em vez do AFD. Use o campo `queryString`.

Ou seja: o iDFace pode ser **100% nuvem via push**, sem IP fixo/VPS e sem
acesso entrante. O servidor enfileira `export_afd`/`load_objects` e recebe o
resultado no `/result`.

### 7.4 Próximos passos

1. ~~Implementar o push server oficial no iZCloud~~ — **feito** nesta sessão
   (ver §8).
2. ~~Coletar AFD via `export_afd` (595/671)~~ — **feito** (§8.3).
3. ~~Importar funcionários de `load_objects users`~~ — **feito** (§8.3), com o
   CPF vindo de `c_users`.
4. Reimportar/validar o push no ambiente real (Railway/Cloudflare) com o iDFace.
5. Definir o contrato de ingestão para o MultiPonto/outros softwares (§8.4).
6. Depois voltar ao iDClass remoto e ao VPS.

## 8. Coletor iDFace implementado no iZCloud (05/11/2026)

### 8.1 Papel

O iZCloud é **coletor + repositório**. O iDFace entrega as marcações; o
REP-P/PTRP do cliente (MultiPonto ou outro) trata jornada e emite os fiscais.
O iZCloud **não** tenta ser REP-P nem reescrever o AFD do equipamento.

### 8.2 Tabelas do tenant

Criadas em `schema_tenant.sql` e em `core.js` (`TENANT_EXTRAS`, para tenants
antigos):

| Tabela | Função |
|---|---|
| `idface_dispositivos` | token, `device_id`, serial, `iDCloud_code`, empresa, portaria |
| `idface_comandos` | fila de comandos (`pendente`/`entregue`/`concluido`/`erro`) |
| `idface_resultados` | resposta bruta de cada `/result` (auditoria) |
| `idface_marcacoes` | marcações normalizadas (AFD e `access_logs`) |
| `idface_usuarios` | último snapshot de `users` + CPF de `c_users` |
| `idface_vinculos` | vínculo versionado `device_user_id` ↔ pessoa |
| `afd_arquivos` | AFD bruto em disco + hash/tamanho/período |

### 8.3 Rotas

Push (público, autenticado pelo token no path):

```text
GET  /api/idface/<schema>/<token>/push?deviceId=...&uuid=...
POST /api/idface/<schema>/<token>/result?deviceId=...&uuid=...&endpoint=...
# também aceita /api/idface/<token>/push|result (varre os tenants, cache 60s)
```

Administração (JWT ou Basic + `X-Client-DB`):

```text
GET    /api/idface/dispositivos
POST   /api/idface/dispositivos            { nome, idEquipamento, portaria }
PUT    /api/idface/dispositivos/:id
DELETE /api/idface/dispositivos/:id        (inativa)
POST   /api/idface/dispositivos/:id/coletar
       { tipo: 'afd'|'logs'|'usuarios', modo: 'completo'|'nsr'|'data',
         formato: '595'|'671', nsr, dataInicio }
GET    /api/idface/dispositivos/:id/marcacoes
GET    /api/idface/dispositivos/:id/usuarios
GET    /api/idface/dispositivos/:id/vinculos
POST   /api/idface/dispositivos/:id/vinculos  { deviceUserId, idPessoa, documento }
```

Leitura para sistemas externos (MultiPonto, Secullum, controle de acesso):

```text
GET /api/idface/marcacoes?idDispositivo=&documento=&inicio=&fim=&limite=
GET /api/idface/arquivos?idDispositivo=&limite=
GET /api/idface/arquivos/:id/download
```

O `POST /dispositivos` devolve `push_base` e `push_url`. No iDFace, configure
`push_remote_address` com o **`push_base`** (o firmware acrescenta `/push`).

### 8.4 Fluxo

1. Criar o dispositivo no iZCloud → receber `push_base`.
2. Configurar `push_remote_address` no iDFace (sem `push_attributes`).
3. No primeiro poll, o iZCloud grava `device_id`/`uuid` e entrega o primeiro
   comando.
4. `POST /dispositivos/:id/coletar` enfileira:
   - `export_afd` (`{}`, `initial_nsr` ou `initial_date`; 671 via
     `queryString: 'mode=671'`);
   - `load_objects` `access_logs` (tempo real);
   - `load_objects` `users` + `c_users` (snapshot para mapeamento).
5. O `/result` é persistido; se for AFD, o arquivo bruto vai para
   `data/afd/<schema>/` e as marcações são normalizadas.
6. O MultiPonto/outro sistema lê `GET /api/idface/marcacoes` e/ou baixa o AFD.

### 8.5 Limites conhecidos

- O `access_logs` e o AFD são fontes diferentes (NSR × `access_logs.id`). O
  iZCloud guarda as duas com `origem`; o consumidor deve escolher uma como
  autoritativa. O AFD é a fonte com NSR/CRC.
- O push não manda serial nem `iDCloud_code`; o token é a autenticação.
- O AFD 1510 do iDFace não tem fuso; o 671 tem. Guardamos `data_hora` (local) e
  `data_hora_utc` (mesmo instante) quando o layout permite.
- Persistência dos arquivos: use o volume `afd_data` do `docker-compose.yml`
  (ou `IZCLOUD_AFD_DIR`); sem volume, some no redeploy.
- O AFD **bruto** do iDClass é o **do REP**: o empregador no header é o que
  está gravado no equipamento. O iZCloud cadastra o empregador para gestão, mas
  ainda **não envia** um comando de empresa ao REP (`load_company` é leitura;
  não há `add_company` documentado/validado). Já o gerador legado 1510
  (`/api/afd/export`) usa `empregadores` e, se vazio, o perfil da empresa
  (`clientes`) para montar o header.
- O gerador legado `/api/afd/export` só monta **1510** (header/trailer
  oficiais). Para **671** ele recusa de propósito: o header/trailer do 671 tem
  CRC do fabricante. Use o AFD bruto (`/api/afd/download` ou
  `/api/afd/arquivos/:id/download`).

### 8.6 Como usar (exemplos)

> Roteiro completo, com menu interativo e configuração do push no iDFace:
> [`TESTE.md`](TESTE.md).

Criar o dispositivo (JWT da conta/empresa):

```bash
curl -X POST https://SEU_HOST/api/idface/dispositivos \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"nome":"iDFace Recepcao","idEquipamento":123,"portaria":"671"}'
```

A resposta traz `push_base` e `push_url`. No iDFace, configure
`push_remote_address` com o **`push_base`** (o firmware acrescenta `/push`).

Coletar (o equipamento executa no próximo poll):

```bash
# AFD completo (671 usa mode=671 automaticamente)
curl -X POST https://SEU_HOST/api/idface/dispositivos/1/coletar \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"tipo":"afd","modo":"completo"}'

# logs em tempo real / snapshot de usuários
curl ... -d '{"tipo":"logs"}'
curl ... -d '{"tipo":"usuarios"}'
```

Ler as marcações (MultiPonto e outros sistemas):

```bash
curl "https://SEU_HOST/api/idface/marcacoes?idDispositivo=1&inicio=2026-11-01&fim=2026-11-30" \
  -u "empresa:senha" -H "X-Client-DB: tenant_0001"
```

Baixar o AFD do iDClass (completo / por NSR / por data):

```bash
# completo
curl -o AFD.txt "https://SEU_HOST/api/afd/download?idEquipamento=123&modo=completo&formato=1510" \
  -u "empresa:senha" -H "X-Client-DB: tenant_0001"

# por NSR
curl -o AFD_nsr.txt ".../api/afd/download?idEquipamento=123&modo=nsr&nsr=5000&formato=1510"

# por data inicial
curl -o AFD_data.txt ".../api/afd/download?idEquipamento=123&modo=data&dataInicio=2026-11-01&formato=1510"
```

> Para 671 use `formato=671`; o arquivo vem bruto do REP (com CRC). O gerador
> legado `POST /api/afd/export` só monta 1510.
