# Protocolos Control iD — o que é oficial, o que descobrimos, o que falta

Documento de referência para a integração do iZCloud com os equipamentos Control iD.
Fontes: documentação oficial da Control iD, análise do firmware `fw.bin` do REP
iDClass, e **medição ao vivo no REP de teste** (`192.168.100.132`).

**Análise iniciada em:** 26/09/2026 · **Canal do REP resolvido em:** 29/09/2026
**Repositório:** `izcloud-conection`

> **Aviso de leitura.** Este documento cresceu por partes. As seções 1 a 8 são o
> raciocínio do começo; as seções 9 a 12 são a medição. Onde a medição contrasta
> com uma hipótese anterior, isso está marcado como **SUPERADO**. Se você só
> quer o estado atual, leia o §1.

---

## 1. Estado atual (leia isto primeiro)

### 1.1 iDFace / iDFlex / iDAccess / coletor — linha de acesso

| Item | Situação |
|---|---|
| Protocolo | API REST oficial: **Push** + **Monitor** |
| Endereço | aceita **domínio** |
| Railway | **serve**, com proxy HTTP comum |
| Estado no código | **não implementado** (é o próximo trabalho) |

### 1.2 REP iDClass 1510 / 671 — linha de ponto

| Item | Situação |
|---|---|
| Protocolo do canal iDCloud | **RESOLVIDO**: a própria API FCGI do REP, sobre **TLS 1.2 na 443** |
| Quem conduz | **o servidor**. O REP abre a conexão e fica mudo esperando |
| Certificado do servidor | **autoassado é aceito** — não valida a CA da Control iD |
| Porta | **443 fixa no firmware** (não segue a porta do web server do REP) |
| SNI / Host | **o REP não envia** — conecta por IPv4 literal |
| Railway | **NÃO serve** (§12.3: a 443 é a borda; o TCP proxy não aceita porta 443) |
| VPS com IP fixo | **necessária** — e pelo controle da borda, não só pelo IP |
| Estado no código | `idcloudServer.js` pronto, com trava de série; coleta implementada |

### 1.3 O que o canal do REP é, em uma frase

O `idcloudServer` faz o papel que a doc oficial descreve para o *software de
desktop*: **abre sessão, lê o que o aparelho tem e grava no nosso banco.** Não há
protocolo binário secreto nem MySQL do lado do REP — era essa a dúvida que
travou o projeto por semanas.

### 1.4 Pendências conhecidas

1. **O AFD não pagina** (§12.5). Só vemos as primeiras 1000 linhas. As batidas
   novas ficam fora de alcance até o aparelho rotacionar o arquivo. **A rotação
   precisa ser confirmada com a Control iD** — é o maior risco do produto.
2. **A tela de "Coletas" não existe** ainda na UI. As rotas estão prontas.
3. **O número curto de iDCloud** (§12.4) não está implementado no nosso fluxo de
   provisionamento de REP.

### 1.5 Decisões de produto já tomadas

- Agente local **descartado** — não queremos software na máquina do cliente.
- Railway cobre **acesso**; **ponto** exige VPS.
- Um schema por empresa no MySQL (`tenant_000N`), com usuário MySQL por empresa
  para o REP — **essa parte do plano MySQL caiu**: o REP não conecta em MySQL.

---

## 2. Linha de CONTROLE DE ACESSO (iDFace, iDFlex, iDAccess, coletor)

Documentação oficial: <https://www.controlid.com.br/docs/access-api-pt>
Exemplos em 5 linguagens: <https://github.com/controlid/integracao/tree/master/Controle%20de%20Acesso>
Coleção Postman: <https://documenter.getpostman.com/view/10800185/SztHW4xo>

### 2.1 Push — o equipamento busca comando no servidor

O equipamento faz requisições **periódicas** ao servidor configurado. Configuração
(`set_configuration.fcgi`):

```json
{ "push_server": {
    "push_remote_address": "https://push.idsecure.com.br/api",
    "push_request_timeout": "30000",
    "push_request_period": "5"
} }
```

> ⚠️ **`push_remote_address` é uma URL completa, não um IP.** Este é o iDCloud
> oficial da Control iD apontando para o servidor deles. Apontamos para o nosso.

**`GET /push?deviceId=<int64>&uuid=<string>`** — busca de comando.
*Resposta:* **vazia** se não há nada a fazer. Caso contrário, o comando:

```json
{ "verb": "POST", "endpoint": "load_objects", "body": { "object": "users" },
  "contentType": "application/json" }
```

`verb` (GET/POST, padrão POST), `endpoint` (o comando), `body`, `contentType`
(`application/json` ou `application/octet-stream` com base64), `queryString`.

**`POST /result?deviceId=<int>&uuid=<uuid>`** — resultado da execução.
Corpo: `{ "response": {...} }` ou `{ "error": "..." }`.
*Resposta do servidor:* **vazia**. Depois disso o equipamento faz novo `/push`.

Comandos em lote — `transactions`:

```json
{ "transactions": [
  { "transactionid": "1", "verb": "POST", "endpoint": "set_configuration",
    "body": { "general": { "language": "en_US" } }, "contentType": "application/json" },
  { "transactionid": "2", "verb": "POST", "endpoint": "message_to_screen",
    "body": { "message": "hello world!", "timeout": 5000 } }
] }
```

Resposta: `{ "transactions_results": [ { "transactionid": 1, "success": true, "response": "{}" } ] }`

### 2.2 Monitor — o equipamento avisa eventos

Configuração (`set_configuration.fcgi`):

```json
{ "monitor": { "request_timeout": "5000", "hostname": "192.168.0.20",
               "port": "8000", "path": "api/notifications" } }
```

> ✅ **A documentação diz, textualmente:** *"O parâmetro hostname no exemplo de
> configuração acima também pode ser um endereço de domínio, como `meuservidor.com`,
> além de um endereço IP."*
> Esta é a confirmação definitiva de que **domínio funciona** nesta linha.

Endpoints (`hostname:port/path` + suffixo):

| Endpoint | Quando |
|---|---|
| `POST /api/notifications/dao` | alterações em `access_logs`, `templates`, `cards`, `alarm_logs` |
| `POST /api/notifications/operation_mode` | mudança de modo (contingência etc.); ao ligar, `last_offline: 0` |
| `POST /api/notifications/device_is_alive` | **heartbeat**; intervalo `alive_interval` (padrão 30 s) |
| `POST /api/notifications/door` | abertura/fechamento de porta |
| `POST /api/notifications/catra_event` | giro de catraca (iDBlock) |
| `POST /api/notifications/access_photo` | foto da identificação (base64), se `enable_photo_upload: 1` |
| `POST /api/notifications/template`, `/face_template`, `/user_image`, `/card`, `/pin`, `/password` | cadastro remoto de credencial com `sync`/`save` = false |

**A batida de ponto chega em `dao`**, no formato:

```json
{ "object_changes": [ { "object": "access_logs", "type": "inserted",
    "values": { "id": "519", "time": "1532977090", "event": "12", "device_id": "478435",
                "identifier_id": "0", "user_id": "0", "portal_id": "1",
                "identification_rule_id": "0", "card_value": "0", "log_type_id": "-1" } } ],
  "device_id": 478435 }
```

### 2.3 Modo Ponto — terminal de acesso virando coletor

`set_configuration.fcgi`:

```json
{ "general": { "attendance_mode": "1" }, "identifier": { "log_type": "0" } }
```

`log_type: 0` = tipo de batida fixo; `1` = customizável pelo usuário na tela.
No Modo Ponto as regras de acesso são desativadas e **toda identificação vira
batida registrada**.

Exportação: `POST /report_generate.fcgi` sobre o objeto `access_logs`, com colunas
`time`, `log_type_id` (tipo), `event` (autorizado/negado), `identifier_id`
(forma de identificação), `user_id`, nome, matrícula, portal. É a via para gerar
relatório de ponto a partir de um iDFace.

### 2.4 Sobre serial e DEVICE ID

O REP/coletor **se identifica sozinho**: `deviceId` (int 64) + `uuid` em toda
requisição de Push; `device_id` em todo evento do Monitor. Isso bate com o que foi
observado em campo ("validam pelo serial e por um DEVICE ID").

No iDCloud oficial existe ainda um **código de verificação** pré-configurado no
aparelho — *não precisamos dele*, porque quem valida é o nosso servidor, não o da
Control iD. Referência: `GET /change_idcloud_code.fcgi` regenera o código;
`system_information.fcgi` mostra o atual.

**Decisão de projeto:** o vínculo aparelho↔empresa é feito pelo iZCloud a partir do
`deviceId` que o próprio aparelho manda. Sem etapa de provisionamento manual.

### 2.5 Firmware por série (importante para testar)

- Firmware **V6** — serial começando em `0M01`–`0M04`
- Firmware **V8** — serial começando em `0M05`–`0M08`

---

## 3. Linha de PONTO (REP iDClass 1510 / 671)

Página do produto: <https://www.controlid.com.br/relogio-de-ponto/idclass/>

### 3.1 API do REP (FCGI) — já implementada no iZCloud

Documentação: <https://www.controlid.com.br/suporte/api_idclass_latest.html>
Postman: <https://www.controlid.com.br/suporte/relogio_de_ponto.postman_collection.php>
Exemplos: <https://github.com/controlid/integracao/tree/master/Ponto%20Eletr%C3%B4nico>

REST, **POST** com `application/json`, sessão em `?session=`. Porta 443, `admin`/`admin`.
SSL obrigatório (certificado autoassinado — `rejectUnauthorized: false` no cliente).

Comandos usados pelo iZCloud hoje: `login`, `get_afd`, `add_users`, `load_users`,
`update_users`, `remove_users`, `get_about`, `get_system_information`, `count_users`,
`get_system_network`, `set_system_network`, `get_idcloud`, `set_idcloud`.

**Parâmetro `mode=671` na query string** alterna o comportamento para a Portaria
671/2021 (CPF em vez de PIS, AFD no formato novo, fuso horário). Sem ele, formato
legado das portarias anteriores. Implementado em `afd.js` / `sync.js`.

### 3.2 API do REP relevante ao iDCloud

```
POST /set_idcloud.fcgi?session=S   { "enable": true|false }
POST /get_idcloud.fcgi?session=S    -> { "enable": true|false }
```

Só isso: um booleano. **O REP não expõe host, porta nem credencial do iDCloud pela
API.** Isso confirma o que foi observado na tela do REP — apenas o botão
ligar/desligar.

### 3.3 O "IP do iDCloud" é endereço de servidor, não domínio

Teste empírico (REP de bancada, `REPCONFIG.exe`):

| Valor gravado em `txtIPCloud` | Resultado |
|---|---|
| `meudominio.com` | **rejeitado** — "IP está errado" |
| IP numérico da Railway | **aceito** |

O campo valida formato de endereço IPv4. Consequência: o REP **exige IP público
fixo**. Um IP dinâmico de nuvem serve só para teste de bancada — em produção o
aparelho fica instalado na sede do cliente e não há como reconfigurá-lo a cada
deploy.

---

## 4. O que o firmware do REP revela sobre o canal iDCloud

Arquivo analisado: `C:\Producao\Gerenciador REPs\fw.bin` (6.291.456 bytes, 2019-01-14).
String de assinatura no dump: `iDClass Mult S` (offset 9) — confirma que é o iDClass.

### 4.1 Máquina de estados (strings de log do próprio firmware)

```
[iDCloud] Looking for iDCloud...
[iDCloud] Server found!
[iDCloud] Handshake is good!
[iDCloud] Connection Failure
[iDCloud] Closing iDCloud...
```

Tela do equipamento: `Conectando-se ao servidor..`, `IDCLOUD CONECTADO`,
`Falha de Conexão`, `Deseja habilitar o iDCloud?`.

### 4.2 Arquitetura interna

Classe de evento `IDCloud::IDCLoudEvent` com `Event::Dispatcher`,
`RegisterIDCloudEvents` e `Event::HandlerQueue` — fila de eventos dedicada, mais a
`iDCloud Task` (thread própria). O REP então é **cliente de um serviço**, o que
coerente com o desenho do iDCloud da Control iD.

### 4.3 ~~O canal é TLS/HTTPS, não MySQL bruto~~ — **SUPERADO por §12.1**

> A conclusão (TLS, não MySQL) estava certa, mas o raciocínio estava errado:
> cheguei nela pela *ausência* de strings de MySQL no firmware. A medição do §12
> mostrou que o canal **é a própria API FCGI do REP** — não havia MySQL para
> procurar. O que sobra daqui, e continua válido, é a sequência de log.

Evidências **negativas** (o que *não* existe no firmware):

- nenhuma ocorrência de `mysql`, `libmysql`, `COM_QUERY`, `mariadb`
- nenhum `CREATE TABLE`; as 20 ocorrências de `SELECT ` não formam SQL de iDCloud
- nenhum username/senha/host de banco
- nenhum hostname do iDCloud oficial (a DLL `Controlid.iDCloud.DataCloud.dll` do
  AFD Downloader tem `cloud1.cjub4athorbi.sa-east-1.rds.amazonaws.com`; o firmware
  **não tem** — ou seja, o endereço vem da configuração, não é embutido)

Evidências **positivas** de TLS:

- stack TLS embarcada: `SSL - Processing of the ClientHello handshake message failed`,
  `ServerHello`, `Certificate`, `CertificateRequest`, `ServerKeyExchange`
- strings de HTTP na mesma região do código iDCloud: `[REST] `,
  `Connection: keep-alive`, `Content-Type: application/octet-stream`,
  `Error on accept incoming connection`, `Error in socket select`,
  `No request data received`

**Conclusão:** a sequência *Looking for → Server found → Handshake* é
resolver/conectar o endereço configurado → **handshake TLS**. O iZCloud precisa ser
o **servidor HTTPS** que o REP procura.

### 4.4 ~~Reconciliação com a documentação do iDCloud~~ — **SUPERADO por §12.1**

> A ideia de "iDCloud como gateway que fala HTTPS com o REP e MySQL com o
> software" era uma hipótese plausível. **Não é assim:** o REP não fala MySQL
> nenhum. Quem fala com o banco é o nosso servidor, **depois** de ler o AFD pela
> API FCGI. A documentação oficial descreve o *cliente de desktop*, que é outro
> papel.

A documentação de integração do iDCloud
(<https://www.controlid.com.br/suporte/exemplos/site/>) diz:

> *"A comunicação com o servidor do iDCloud deve ser feita através de uma conexão
> direta com o banco de dados que é MySQL [...] disponibilizamos as principais
> queries no banco de dados."*

Isso **não contradiz** o firmware: são **dois lados diferentes**.

- **REP → servidor iDCloud**: HTTPS/TLS (é o que o firmware faz).
- **Software do cliente (RHiD) → banco do iDCloud**: MySQL direto (é o que a doc
  ensina a integrar).

O iDCloud oficial é, portanto, um **gateway**: fala HTTPS com o REP e MySQL com o
software. Para o iZCloud ser equivalente, precisamos implementar o **lado HTTPS**
(o que o REP fala) e respeitar o **modelo de dados** (as tabelas, que a doc define
e que o `schema_tenant.sql` já espelha).

### 4.5 O que o firmware NÃO revela

- o payload de aplicação depois do TLS (não há string de protocolo em texto claro:
  está ofuscado, criptografado ou em outra partição da flash)
- a porta usada
- como a autenticação é feita (certificado? token? nada?)

Isso só se descobre **capturando o tráfego** — ver §8.

---

## 5. O modelo de dados do iDCloud (o contrato)

Fonte: <https://www.controlid.com.br/suporte/exemplos/site/tabela_referencias/>

O REP lê e escreve **diretamente no banco**. `DataAtualizacao` é o **cursor de
sincronização**: sem atualizá-lo, a alteração nunca chega ao aparelho.

| Tabela | Acesso pelo REP | Campos |
|---|---|---|
| `equipamentos` | **só leitura** | `id_Equipamento` (= nº de série), `id_Empregador`, `Nome`, `utc_Equipamento`, `AplicaHorarioVerao`, `statusPapel`, `qtdePessoas`, `qtdeDigitais` |
| `pessoas` | leitura + escrita | `id_pessoa`, `PIS` (BIGINT), `Nome` (52), `Codigo` (INT), `Senha` (6), `Matricula` (INT), `Admin` (BIT), `RfId` (BIGINT), `Barras` (15), `Excluido` (BIT), `ExcluidoDefinitivo` (BIT), **`DataAtualizacao`**, `id_departamento` |
| `equip_pessoa` | leitura + escrita | `id_Pessoa`, `id_Equipamento` |
| `templates` | leitura + escrita | `id_Pessoa`, `Template` (TEXT, base64) |
| `departamentos` | leitura + escrita | `id_departamento`, `nome`, `todos` |
| `departamentos_equip` | leitura + escrita | `id`, `id_departamento`, `id_Equipamento` |
| `empregadores` | leitura + escrita | `id_Empregador`, `RazaoSocial` (50), `Local` (100), `CNPJ_CPF` (20), `CEI` (20), `CPF` (20) |
| `afd` | **só leitura** | `id_Equipamento`, `PIS` (BIGINT), `NSR` (INT), `Data` (DATETIME), `Tipo` (INT), `Dado` (300), `CRC` (CHAR 4) |

Semântica de `Excluido` vs `ExcluidoDefinitivo`:

- `Excluido = 1` → sai do aparelho, mas continua aparecendo (inativo) na interface
- `ExcluidoDefinitivo = 1` → some do aparelho **e** da interface

Regra de `departamentos.todos = 1`: quem não tem departamento é enviado a
**todos** os equipamentos; com departamento, só aos equipamentos vinculados.

> **Regra do Inmetro citada na doc:** *"não deve existir dois cartões (RFID) na
> tabela pessoas com o mesmo número"* — a unicidade precisa ser garantida por nós.

### 5.1 O que já está idêntico e o que falta

O `schema_tenant.sql` original já usa os mesmos nomes de tabela e a mesma
estrutura — porque foi desenhado sobre este contrato. **Já tinha:** `equipamentos`,
`pessoas` (com `PIS`, `CPF`, `Nome`, `Codigo`, `Senha`, `Matricula`, `Admin`,
`Rfid`, `Barras`, `Excluido`, `ExcluidoDefinitivo`, `DataAtualizacao`,
`id_departamento`), `equip_pessoa`, `templates`, `afd` (`NSR`, `Data`, `Dado`, `CRC`).

**Faltava, e foi completado em 26/09/2026:**

| Item | Situação |
|---|---|
| tabelas `departamentos`, `departamentos_equip`, `empregadores` | **criadas** |
| `templates.Template` (a coluna que a doc pede) | **criada**, espelha `dados` |
| `equipamentos.Serial` (texto, com zeros à esquerda) | **criada** |
| índice em `pessoas.DataAtualizacao` | **criado** |
| `UNIQUE KEY uq_rfid (Rfid)` — regra do Inmetro | **criada** (tenant novo; em tenant antigo só se não houver duplicados) |
| **`id_Equipamento` de `INT` para `BIGINT` em 6 tabelas** | **corrigido** — ver abaixo |
| `aplicarMigracoesTenant()` | **criada** — roda ao criar empresa e por rota |
| `gerarCredencialRep()` | **criada** — usuário MySQL com `GRANT` só no schema da empresa |

### 5.2 O bug do `id_Equipamento` (importante)

A doc diz que `id_Equipamento` é o "número de série" do aparelho e o define como
`INT`. **Um serial real tem 17 dígitos** — o do REP de homologação é
`00014003750029470` = 14.003.750.029.470, e `INT` para em 2.147.483.647.

Nenhum REP real caberia nesse campo. Corrigido para `BIGINT` em **todas** as seis
tabelas que o referenciam: `equipamentos`, `sync_status`, `equip_pessoa`, `afd`,
`marcacoes`, `departamentos_equip`. Como `Serial` guarda o texto, os zeros à
esquerda não se perdem.

> **Ponto em aberto:** a doc oficial descreve `INT(11)`, que em MySQL continua
> 32 bits — ou seja, ou a doc é imprecisa, ou o iDCloud oficial usa um id numérico
> menor que o serial impresso na etiqueta. Não dá para resolver sem ver um REP de
> verdade lendo o banco. Por isso a chave `Serial` existe ao lado: quando o REP for
> testado, dá para descobrir qual das duas ele casa.

### 5.3 Como o REP é cadastrado agora

Antes o `id_Equipamento` era um número escolhido na tela. Isso quebraria o
casamento do REP no banco. Agora:

1. **Sondar** chama `get_about.fcgi` e devolve o `nSerie` real do aparelho;
2. o campo de cadastro mostra esse serial, **somente leitura**;
3. `POST /api/reps` usa o **serial como `id_Equipamento`** (o que o aparelho
   reportou), e guarda o texto em `Serial`;
4. salvar sem sondar antes é bloqueado na UI e a API exige um id inteiro válido.

### 5.4 Isolamento por empresa x contrato iDCloud

O iZCloud usa **um schema por empresa** (`tenant_0001`). O REP do iDCloud oficial
conecta num único banco. Nada impede: `gerarCredencialRep()` cria um usuário
MySQL por empresa com `GRANT` **apenas no próprio schema** — sem acesso a
`izcloud_core` e sem outros tenants. É assim que o isolamento se mantém nesse
modelo.

Rotas:

- `POST /api/empresas/migrar-contrato` — roda `aplicarMigracoesTenant()` (para
  empresas criadas antes das tabelas novas)
- `POST /api/empresas/credencial-rep` — cria/rotaciona o usuário MySQL e devolve
  host, porta, usuário e senha **uma única vez**


---

## 6. Lições do `dump-write.bin`

`C:\Producao\Gerenciador REPs\dump-write.bin` — 131.072 bytes (128 KB).
Contém a assinatura `iDClass Mult S` no offset 9, mas **nenhum** endereço IP e
**nenhuma** string de rede/protocolo. É uma região de firmware/flash, não a
configuração de nuvem. Não foi útil para esta análise; o `fw.bin` foi.

---

## 7. Decisão de infraestrutura

### 7.1 iDFace / iDFlex / coletor → Railway, sem VPS

`push_remote_address` e `monitor.hostname` aceitam **domínio**. Basta apontar
para o domínio do iZCloud e implementar os endpoints (§2.1, §2.2) com autenticação
por dispositivo. Custo zero adicional.

### 7.2 REP iDClass → VPS com IP fixo

O REP exige IPv4 literal. Ainda não sabemos a porta nem o payload (§4.5), mas a
infraestrutura é a mesma nos cenários: **VPS com IP público fixo**, com um serviço
nossa escutando o canal iDCloud, encaminhando para a aplicação (que pode continuar
na Railway, com o banco dela).

Estimativa: US$ 4–6/mês (VPS 1 GB) + Caddy para TLS. A Railway continua servindo
app, painel e banco.

### 7.3 O que NÃO fazer

- **IP dinâmico em produção.** O REP fica na sede do cliente; não há como
  reconfigurar a cada deploy. Serviu só para provar que o campo aceita número.
- **Agente local** — descartado: exigiria software na máquina do cliente.
- **Expor o MySQL da Railway na internet.** Além de inseguro, a Railway não
  oferece MySQL público.

---

## 8. Como fechar a lacuna do payload (§4.5)

Método que não depende de hipótese: **observar o REP falando com um servidor nosso.**

1. Na mesma LAN do REP, subir uma máquina com IP fixo (ex.: `192.168.100.10`).
2. Gravar `txtIPCloud` com esse IP.
3. Rodar um listener que aceite a conexão e despeje tudo que chegar:
   ```bash
   # captura bruta, com contagem de bytes por conexão
   ncat -l 3306 --keep-open --exec "tee -a /tmp/rep.bin"
   # ou, escutando todas as portas para descobrir a usada:
   ncat -l 0.0.0.0 0 --keep-open --sh-exec 'echo porta=$0 >&2; cat >> /tmp/rep_$0.bin'
   ```
   Também dá para deixar o REP tentar enquanto se captura o log do REP
   (`[iDCloud] ...`) — ele informa se achou o servidor e se o handshake passou.
4. Analisar o capturado: primeiro o handshake TLS (é esperado), depois o que vem
   **já dentro do túnel** — que é o protocolo da aplicação. Com certificado
   autoassinado do lado do REP, dá para inspecionar o TLS (ex.: `openssl s_client`)
   ou aceitar o certificado com `ssl.SSLContext` e logar o payload descriptografado
   no seu proxy.
5. Confirmar a porta: se o handshake TLS completar numa porta específica, achamos a
   porta. Se completar em 443, é 443.

O que procurar no payload: magic/versão, número de série, tipo de mensagem,
tamanho, e se há `SELECT`/`INSERT` de verdade (o que confirmaria ou refutaria a
hipótese MySQL-sobre-TLS).

---

## 8-bis. Referências

| Assunto | Endereço |
|---|---|
| API controle de acesso (Push/Monitor/Modo Ponto) | <https://www.controlid.com.br/docs/access-api-pt> |
| Push | <https://www.controlid.com.br/docs/access-api-pt/modo-push/introducao-ao-push/> |
| Conexão com iDCloud (acesso) | <https://www.controlid.com.br/docs/access-api-pt/modo-push/idcloud/> |
| Monitor | <https://www.controlid.com.br/docs/access-api-pt/monitor/introducao-ao-monitor/> |
| Modo Ponto | <https://www.controlid.com.br/docs/access-api-pt/modo-ponto/funcionamento/> |
| Exemplos (acesso) | <https://github.com/controlid/integracao/tree/master/Controle%20de%20Acesso> |
| API do REP iDClass | <https://www.controlid.com.br/suporte/api_idclass_latest.html> |
| Exemplos (ponto) | <https://github.com/controlid/integracao/tree/master/Ponto%20Eletr%C3%B4nico> |
| iDCloud — introdução | <https://www.controlid.com.br/suporte/exemplos/site/> |
| iDCloud — tabelas do banco | <https://www.controlid.com.br/suporte/exemplos/site/tabela_referencias/> |
| iDCloud — exemplo de integração | <https://www.controlid.com.br/suporte/exemplos/site/exemplos/> |
| Produto REP iDClass | <https://www.controlid.com.br/relogio-de-ponto/idclass/> |
| Produto iDFace | <https://www.controlid.com.br/controle-de-acesso/idface/> |
| Portal do AFD Downloader (venda separada) | <https://www.controlid.com.br/suporte/idcloud/index.php> |

Arquivos locais relevantes:

- `C:\Producao\Gerenciador REPs\fw.bin` — firmware do REP (6 MB, 2019-01-14)
- `C:\Producao\Gerenciador REPs\dump-write.bin` — dump de 128 KB, sem conteúdo útil aqui
- `C:\Producao\Gerenciador REPs\REPCONFIG.exe` — gravador de `txtIPCloud` (valida IPv4)
- `C:\Producao\Gerenciador REPs\AFD Downloader\Controlid.iDCloud.DataCloud.dll` —
  cliente de desktop do iDCloud; contém o host `cloud1.cjub4athorbi.sa-east-1.rds.amazonaws.com`
  e a referência de estrutura de tabelas
- `C:\Producao\Gerenciador REPs\AFD Downloader\iDClassREP.dll` — cliente FCGI do REP
- `C:\Producao\Gerenciador REPs\app_idface.py` — script local de teste do iDFace
  (`http://{ip}/login.fcgi`, sessão) — outro protocolo, distinto do Push

## 9. Sondagem no REP real (28/09/2026)

Sondado o REP de teste em `192.168.100.132` (iDClass Mult, admin/admin, HTTPS
na 443):

| Leitura | Resultado |
|---|---|
| `get_about` | `nSerie = "00014003750029470"`, `versionFW = 1048`, `versionMRP = 1560` |
| `get_idcloud` | `{"enable": true, "interval": 2078000}` -- **o canal iDCloud esta LIGADO** |
| `get_system_network` | `192.168.100.132/24`, gateway `192.168.100.1` |
| `get_configuration` | **128 KB de binario cru** (131072 bytes), nao JSON |

### 9.1 O serial em hexadecimal tem 11 digitos

Confirma a hipotese, e fecha o `id_Equipamento`:

.. code-block:: text

    00014003750029470  (decimal)  =  0xCBC808BC89E  (11 digitos hex)

O `11` da documentacao oficial nao e largura de `INT`: e' o tamanho do
serial em hex. `INT` (32 bits) nao comporta esse valor em nenhuma encoding.
**BIGINT e' obrigatorio**, e `Serial VARCHAR(32)` guarda o texto.

### 9.2 A configuracao e' um blob binario com CRC32

O IP do iDCloud esta gravado **como 4 bytes**, nao como texto:

.. code-block:: text

    offset 2744: 02 01 01 01 01            flags
    offset 2749: 45 2e 2e 70               69.46.46.112  <- o IP gravado
    offset 2756: 30 b5 1f 00               2078000 LE    <- o mesmo interval
    offset 2766: "00014003750029470"        o serial, em ASCII

Tres conclusoes que mudam o plano:

1. **A porta nao esta na configuracao.** Depois do IP vem o `interval`, que casa
   exatamente com o `get_idcloud`. Busquei 3306, 3307, 33060, 443, 8080, 8443
   e 2098 no blob inteiro: **nenhuma esta la**. A porta e' **hardcoded no
   firmware** e so da para descobrir observando a conexao.
2. **Nao ha campo de usuario/senha de banco** em lugar nenhum do blob. A doc
   oficial manda configurar credencial de MySQL no iDCloud; este aparelho nao
   tem onde guardar uma. Isso enfraquece a hipotese de MySQL direto.
3. `set_configuration` so aceita **JSON** (form-urlencoded da
   `Unsupported Content-Type`) e valida um **CRC32** sobre o `binary` em
   base64. O CRC ainda nao foi quebrado, entao o iZCloud nao mexe na
   configuracao do aparelho sozinho -- quem configura e' o `REPCONFIG.exe`.

No config aparece tambem um certificado CN=`192.168.100.132` e chave privada
de 2048 bits. E' o certificado **do servidor web do proprio REP** (e' por ele
que ele responde em HTTPS na 443), nao credencial de iDCloud.

### 9.3 O `/push` do pontoweb e' especulativo

`C:\Producao\pontoweb` e `C:\Producao\idacessoweb` tem um endpoint `/push`
com polling HTTP. **Nao e' o iDCloud da Control iD** e nunca foi testado contra
um aparelho:

- o backend e' Express + arquivo JSON, **sem `mysql2`** (zero MySQL nos dois);
- o `tipo_conexao: 'idcloud'` do pontoweb so significa "falar com o meu
  servidor HTTP em vez do IP direto" -- tres `fetch` contra a propria API;
- o parser de eventos e' um chute que aceita `transactions`, `events`,
  `logs`, `markings`, `access_logs` e campos
  `user_id`/`userId`/`id_user`/`pis`/`cpf` "no que vier".

O que **e'** real e reaproveitavel: o bloco `push_server` gravado por
`set_configuration` com `push_remote_address`, `push_request_period` e
`push_attributes: serial=...`. E' o mecanismo que faz o REP iniciar a
conexao -- e o `push_remote_address` aceita **URL**, o que resolveria o
problema do IP fixo. Falta confirmar que este firmware honors esse bloco.

### 9.4 O coletor no iZCloud

`POST /push` responde `200` para qualquer coisa e grava os bytes crus em hex
e em texto, justamente para a tentativa nao se perder. Leitura em
`GET /api/admin/capturas?corpo=1` (so admin).

Para **descobrir a porta**, o jeito e' ver a conexao chegando:

.. code-block:: bash

    node captura_rep.mjs          # escuta 33 portas em 192.168.100.179

com o `txtIPCloud` do REP apontado para `192.168.100.179` (esta maquina,
mesma sub-rede). E' teste **de diagnostico**, nao de deploy.

.. warning::

   O capturador escuta a 3306 entre outras. Se ficar rodando enquanto a suite
   e2e sobe, ela conversa com o capturador em vez do MySQL e os testes passam
   por engano. Ja aconteceu. Pare o capturador antes de rodar qualquer teste.


## 10. O AFD Downloader do Control iD (descompactado) — a fonte oficial

Em `C:\Producao\Gerenciador REPs\AFD Downloader` está o cliente **oficial** do
iDCloud. Não é o mesmo firmware do REP, mas é o outro lado do protocolo, e ele
responde as perguntas que faltavam.

### 10.1 A configuração real (`ControliD.iDCloud.LocalService.exe.config`)

```xml
CloudBase: Server=cloud1.cjub4athorbi.sa-east-1.rds.amazonaws.com;
           Database=idcloudbase;Uid=service;Pwd=...
CloudTeste: ...;Database=idcloudteste;Uid=main;Pwd=...
IP   = auto
Port = 443
CertificateFile     = CodeSigning2017.pfx
CertificatePassword = controlid1818
CloudUTC = -3
```

Três coisas decorrem disso:

- **A porta do canal é 443.** O MySQL (RDS) é do *cliente de desktop*; o canal de
  serviço é HTTP com **443** e **certificado do cliente** (mutual TLS). É o
  arquivo `CodeSigning2017.pfx` que está na mesma pasta.
- **O iDCloud é MySQL + HTTP.** O `DataCloud.dll` usa `MySqlConnector` e
  `HttpWebResponse`. Não é "MySQL direto do REP" nem só "HTTPS": o serviço fala
  os dois.
- As credenciais do RDS estão **em texto puro no .config** (e a senha do SMTP do
  helpdesk também). Vale registrar como risco, não como notícia.

### 10.2 O iDCloud tem DOIS dialetos de schema

O `DataCloud.dll` consulta as duas formas, e o firmware tem 2019 — provavelmente
usa a antiga (português), mas o serviço aceita as duas:

```sql
-- dialeto antigo (português, id_Pessoa)
SELECT * FROM @schema.Templates WHERE id_Pessoa = {0}
INSERT INTO @schema.AFD (id_Equipamento, PIS, NSR, Data, Tipo, Dado, CRC, ...)

-- dialeto novo (inglês, idDevice)
INSERT INTO @schema.AFD (idDevice, PIS, NSR, Tipo, dateTime, text, CRC, dateInserted, mobile)
INSERT INTO @schema.Template (idPerson, Template, excluded) VALUES (...)

select t1.* from @schema.person t1
where t1.excluded=FALSE and t1.status=1 and t1.pis>0 and t1.pis<999999999999
```

Atenção: no dialeto novo, `AFD` tem colunas `Tipo`, `dateTime`, `text`, `CRC`,
`mobile`, `timeZone` — não `Data`/`Dado` como no antigo.

### 10.3 Como o REP sabe que há dado novo: um TRIGGER

```sql
BEGIN
  update idcloudbase.clientes set lastUpdate = NEW.dataAtualizacao
   where id_cliente = @id_cliente;
END
```

Este é o mecanismo de "cursor" do iDCloud oficial: mexer em `pessoas` bumps
`clientes.lastUpdate`, e o outro lado olha esse campo. É a mesma ideia do
`pessoas.DataAtualizacao` que já indexamos — o oficial só materializa isso em um
segundo nível, no `clientes`.

### 10.4 O que o firmware tem (e o que não tem)

Do `fw.bin` (6 MB, ARM + mbedTLS + rapidjson):

- **NÃO** tem `mysql`, `mysqld`, `MariaDB`, `3306`, `amazonaws`
- **NÃO** tem `idsecure` nem nenhuma URL de serviço
- tem `get_idcloud` e `set_idcloud` como comandos **FCGI** (é por isso que
  `get_idcloud.fcgi` responde)
- tem o cliente C++ na hierarquia `CiD::IDCloud::IDCLoudEvent`, com
  `RegisterIDCloudEvents` e `HandlerQueue` — os símbolos **não** estão
  ofuscados
- tem a sequência, com rapidjson ao lado:

  ```text
  [iDCloud] Looking for iDCloud...
  [iDCloud] Server found!.
  [iDCloud] Handshake is good!.
  [iDCloud] Connection Failure....
  ```

- tem mbedTLS completo, com SNI (`client hello, adding server name extension: %s`)
- `Content-Type: application/octet-stream` e `[REST] ` aparecem no binário

Cuidado com um falso positivo: `https://%u.%u.%u.%u:%u` **não** é o canal do
iDCloud. Ela está no bloco do servidor web do próprio REP, num
`HTTP/1.1 301 Moved Permanently / Location:` — ou seja, é o redirect de
HTTP para HTTPS do REP, usando o IP e a porta **dele**.

**Conclusão:** o REP faz **TLS com JSON** (rapidjson + mbedTLS + "Handshake is
good"). "Server found" é o socket conectado; "Handshake is good" é o TLS
completado. O "Looking for" sugere até resolução de endereço.

### 10.5 ~~Efeito no plano: a Railway volta a ser viável~~ — **ERRADO, corrigido em §12.3**

> Aqui cheguei a concluir que a Railway serviria, só porque a porta 443 é HTTPS.
> **Não serve.** A 443 da Railway é a borda, que encerra o TLS e roteia por
> SNI/`Host`, e o REP não envia nenhum dos dois. Além disso a Railway não deixa
> escolher a porta pública do TCP proxy, só permite um por serviço, e ele não
> aceita 443. Ver a medição em §12.3.

Com a porta **443** confirmada, o canal é HTTPS — e a Railway publica HTTPS. Então
o teste que você queria fazer primeiro faz sentido, e **não precisa mexer no
REP**: ele já está apontado para `69.46.46.112`.

Ressalvas honestas:

- a borda da Railway encerra o TLS, então o certificado do cliente chega
  **apenas** se o REP mandar como header (normalmente não manda). Isso impede
  autenticar por mTLS — mas não impede ver o tráfego;
- se o firmware validar a CA do Control iD no servidor, nosso certificado
  autoassado é recusado. Se ele só fizer o handshake (as mensagens de erro do
  mbedTLS sugerem que é tolerante), funciona;
- o caminho da URL é desconhecido — por isso o coletor responde em `/push` e nas
  variantes, e aceita qualquer método.

O `interval` gravado no REP é **2078000**. Se for milissegundos, são ~35 min
entre tentativas; se for segundos, ~24 dias. Vale descobrir antes de esperar.
## 11. O canal iDCloud, medido no REP de teste (29/09/2026)

Tudo abaixo foi observado com o REP real em `192.168.100.132`, com o
`txtIPCloud` apontado para `192.168.100.179` (esta maquina).

### 11.1 O que o REP faz, na ordem

1. Abre conexao TCP na **443** a cada ~30 s. Nenhuma outra porta foi tocada.
2. Manda um **ClientHello** de 400 bytes. TLS 1.2 puro.
3. Aceita o handshake com um certificado **autoassado**.
4. **Nao manda absolutely nada depois do handshake** e espera ~30 s.

Handshake registrado no servidor:

```text
versao ....: TLSv1.2
cipher ....: ECDHE-RSA-AES128-GCM-SHA256
certificado do cliente: (NAO MANDOU)
SNI (servername): (ausente)
```

O ClientHello traz 141 cipher suites, `signature_algorithms`,
`supported_groups`, `ec_point_formats` e `session_ticket` — e **nada** de
`server_name` nem `ALPN`. Confirma: o REP conecta por IP literal e nao manda SNI.

### 11.2 O REP NAO valida a CA da Control iD

O firmware embute a CA (encontrei a string exata, com as validity):

```text
2396132  CN=Control iD CA,O=Controlid Industria e Comercio de Hardware e Servicos
         Ltda,OU=Engenharia,ST=SP,L=Sao Paulo,C=BR
2396100  20010101000001        (notBefore da CA)
2396116  20300101000001        (notAfter da CA)
2396252  [SSL] Novo certificado criado com sucesso!
2396352  Certificado nao corresponde ao IP atual. Criando novo certificado..
```

E o certificado que o proprio REP gera (achado no config de 128 KB) e' o
certificado **do servidor web dele**, CN=`192.168.100.132` — nao credencial de
iDCloud.

Mesmo assim, o REP **aceitou nosso certificado autoassado** sem reclamar. Ou
seja: a CA embutida e' usada para o REP gerar o proprio certificado, e o canal
do iDCloud nao exige cadeia assinada pela Control iD. Consequencia pratica:
**na VPS podemos usar certificado autoassado**, sem comprar CA.

### 11.3 O servidor e' quem fala primeiro

Depois do handshake o REP fica calado. Mandei seis probes (resposta HTTP 200,
`{"transactions":[]}`, `{"result":true}`, `{"status":"ok"}`, `{"session":""}`,
`CID-REP_iDClass:`) e ele nao respondeu a nenhum. O formato do primeiro comando
do servidor continua desconhecido.

### 11.4 `set_idcloud` existe: da para mexer no intervalo por FCGI

```js
await fcgi('set_idcloud', { enable: true, interval: 15 });   // -> {}
// get_idcloud passa a devolver {"enable":true,"interval":15}
```

`enable` e' obrigatorio; `interval` e' opcional. Isso resolve a limitacao do
`REPCONFIG.exe`: com `interval: 15` o REP tenta a cada ~30 s, sem esperar as
horas do 2078000. `https_rep.mjs` e `vigia.mjs` fazem isso e restauram o valor
no fim.

### 11.5 O hostname oficial — e por que a Railway esta fora

O cliente oficial (`ControliD.iDCloud.LocalService.exe`, que se descreve como
*"Servidor de sincronismo dos equipamentos REP iDClass da Control iD"*) tem:

```text
txtHost        -> idclass1.idcloud.com.br     (resolve para 54.233.124.250)
{{ email = {0}, password = {1} }}
token / login / accessToken / Authorization / Bearer
http://localhost/rhidv2/afddownloader.svc/
application/json
download?idEquipamento={0}&nsrInicial={1}&limit={2}&coletor={3}
devices
```

Ou seja, o iDCloud e' **RHiD v2**: `POST` com JSON de credenciais, devolve
`accessToken`, e as chamadas seguintes vao com `Authorization: Bearer`.

**Por que a Railway nao serve o REP:**

- o REP nao manda SNI (comprovado) e nao manda `Host` utilizavel;
- a borda da Railway e' um ingress compartilhado que roteia por SNI/`Host`;
- o REP so conecta por IPv4 literal, e `txtIPCloud` nao aceita dominio;
- resultado: TLS fecha (a borda tem certificado), a requisicao morre no
  roteamento, e o aparelho diz "conectado" porque so viu o handshake.

Isto **confirma a VPS como obrigatoria**, e nao so por causa do IP fixo: e' pelo
controle da borda. Na VPS aceitamos qualquer `Host` e podemos terminar o TLS
mesmo, com qualquer certificado.

### 11.6 ~~O que ainda falta~~ — **SUPERADO por 12.1**

> A duvida era o formato do primeiro comando. **Resolvido:** e'
> POST /<comando>.fcgi com JSON, exatamente a API FCGI ja implementada em
> epClient.js. As chaves RHiD v2 (hidv2, Bearer, ccessToken) sao do
> cliente de **desktop** e nao aparecem no firmware do REP.texto

### 11.6-bis O que ainda falta (depois da medicao)

O **formato do primeiro comando do servidor** depois do TLS. Os caminhos
candidatos vem do RHiD v2 (`/rhidv2/...`, `login`, `Authorization: Bearer`), mas
isso e' do cliente de desktop — o firmware nao contem `rhidv2`, `Bearer` nem
`Authorization` (0 ocorrencias). O proximo passo com maior chance de resolver e'
descompilar o `ControliD.iDCloud.LocalService.exe`, que e' o outro lado exato
desse canal.
## 12. O canal iDCloud, resolvido (29/09/2026)

O REP foi apontado para `192.168.100.179` (esta maquina) e conduzido comando a
comando. Nao ha misterio: **o canal iDCloud e' a propria API FCGI do REP, sobre
TLS na 443, com quem conduzindo sendo o SERVIDOR.**

### 12.1 A sequencia

Numa unica conexao TLS, sem o REP enviar um byte sequer:

```text
POST /login.fcgi                  {"login":"admin","password":"admin"}
  -> {"session":"cJHFbXtyck33dghdWvVKCOkl"}
POST /get_about.fcgi              {}
  -> {"mac":"FC:52:CE:80:E1:A5","nSerie":"00014003750029470",...}
POST /get_system_information.fcgi {}
  -> {"user_count":20,"template_count":33,"last_nsr":38530,...}
POST /get_afd.fcgi                {"limit":1000,"offset":0,"session":"..."}
  -> application/octet-stream, o arquivo AFD
POST /load_users.fcgi             {"limit":3,"offset":0,"session":"..."}
  -> {"users":[...]}
POST /load_company.fcgi           {"session":"..."}
  -> {"company":{"name":"FERNANDO DE CASTRO",...}}
```

Por isso o REP "nao mandava nada": ele esta se comportando como servidor,
esperando ser---ido. Nao ha protocolo binario secreto, nem MySQL, nem
obfuscacao.

### 12.2 Transporte

| Item | Medido |
|---|---|
| Porta | **443**, fixa no firmware |
| TLS | 1.2, `ECDHE-RSA-AES128-GCM-SHA256` |
| SNI | ausente (conecta por IPv4 literal) |
| ALPN | ausente |
| Certificado do cliente | nao manda |
| Certificado do servidor | **autoassado e aceito** |

O firmware embute a CA (`CN=Control iD CA`, em 2396132, com as validades
`20010101000001`/`20300101000001`), mas usa para gerar o certificado **do
proprio REP** (CN=`192.168.100.132`, achado no config de 128 KB) - nao para
validar o servidor do iDCloud. Logo: **nao ha compra de certificado**.

### 12.3 A porta do iDCloud NAO segue a do servidor web

O `set_idcloud` aceita `enable` e `interval` e **ignora tudo o mais** (devolve
`{}` ate para chave inventada - testei `port`, `porta`, `tcp_port`, `xyz`).

Teste decisivo: com o servidor web do REP em 5432 e o bloco de config
confirmando `IP=192.168.100.179` + `interval`, ouvindo nas duas portas:

```text
escutando 192.168.100.179: 443, 5432, 8080, 8443, 2098, 33306
>>> CONEXAO NA PORTA 443     TLSv1.2  ECDHE-RSA-AES128-GCM-SHA256
>>> CONEXAO NA PORTA 5432    (nenhuma)
```

E o bloco do iDCloud no config nao tem onde guardar porta (`5 flags + IP(4) +
reservado(3) + interval(4)`). A porta do web server, essa sim, e' configuravel
(offset 2432).

**Consequencia: a Railway esta fora.** A 443 e' a borda (a documentacao diz
"Railway's edge terminates TLS on 443") e todo trafego passa por ela; o REP nao
manda SNI nem `Host` utilizavel. Alem disso a Railway **nao deixa escolher** a
porta publica do TCP proxy (ela gera uma, ex. `shuttle.proxy.rlwy.net:15140`),
e so permite **um** TCP proxy por servico. O proxy em 5432 portanto nao serve
para o REP.

### 12.4 O numero curto de iDCloud

Nos 19 usuarios do REP, **um so tem numero curto**:

```text
pis=123   ( 3 dig)   code=0   rfid=0   ADMIN
```

Todos os outros tem PIS de 11 digitos. Esse e' o numero que a Control iD gera
ao habilitar o iDCloud e que o tecnico cadastra no REP no lugar do PIS/CPF -
serve para amarrar o aparelho a uma empresa na nuvem. Como o REP e' passivo
nesse canal, o numero e' informacao de bookkeeping do lado da nuvem, nao um
segredo que o aparelho apresenta.

### 12.5 O AFD: limite real do aparelho

```text
201 linhas, tipos: {"0":1, "2":2, "3":148, "4":2, "5":43, "6":5}
```

- **tipo 3** sao as batidas (942 na janela de 1000 linhas);
- tipo 0 e' o rodape, tipo 2 a empresa, tipo 5 eventos de operador (com nome).

O `get_afd` deste firmware tem tres limites medidos:

1. `limit` maximo **1000** (acima: `'limit' m-ximo - 1000`);
2. `offset` e' aceito mas **ignorado**;
3. `nsrInicial`, `start`, `from`, `skip`, `dataInicio`, `mode`, `coletor`...
   **nao paginam** - todos devolvem as mesmas primeiras N linhas.

Ou seja: **da para ler so o comeco do AFD**, e como o arquivo cresce anexando no
fim, as batidas mais novas ficam fora de alcance ate o aparelho rotacionar. O
cliente oficial contorna isso porque pagina no nivel da nuvem
(`download?idEquipamento=&nsrInicial=&limit=&coletor=` contra o `rhidv2`), nao no
aparelho.

Consequencias no codigo:

- `baixarAfd` faz **uma** requisicao e marca `truncado` - nao pagina, para nao
  gravar a mesma janela 20 vezes (erro que eu cometi e que o teste pegou);
- a gravacao e' **idempotente por NSR**: a tabela `afd` ja tem
  `UNIQUE (id_Equipamento, NSR)`, entao a janela que volta sempre e' absorvida;
- `rep_coletas` guarda `ultimo_nsr` para a UI mostrar se a coleta avanca.

### 12.6 O que foi construido

`idcloudServer.js`:

- `atenderConexao` - `get_about` primeiro, compara o `nSerie` com o REP esperado
  daquele vagao, e so entao faz `login`. Sem vaga, derruba a conexao.
- `SessaoRep` - cliente FCGI sobre a conexao TLS. Slot unico de pendencia (os
  comandos sao sequenciais), aceita fim de linha em `\n` e `\r\n` (o REP mistura
  os dois), e espera 500 ms antes do primeiro comando (mandando na hora o
  aparelho ignora e a resposta nunca vem).
- `coletar` - baixa o AFD, grava e atualiza o estado.
- `criarServidor` - sobe se `cert.pem`/`chave.pem` existirem; caso contrario o
  app segue normal so pela API.

Rotas: `POST /api/reps/:id/reservar-coleta`, `GET /api/reps/:id/coleta`,
`GET /api/coletas`.


---

## 13. Runbook — o que fazer quando houver a VPS

Tudo aqui foi validado na rede local, contra o REP real. A VPS muda o endereço,
não a lógica.

### 13.1 Provisionar

1. VPS com **IP público fixo** e **porta 443 liberada** (e nada mais: o REP só
   fala com a 443).
2. Certificado. **Autoassado funciona** — o REP não valida a CA da Control iD
   (§11.2). Se preferir válido, Let's Encrypt é indiferente para o aparelho.
3. apontar um nome para o IP e instalar o certificado no servidor.
4. No `idcloudServer.js`, nada muda: `IDCLOUD_CERT`, `IDCLOUD_KEY`,
   `IDCLOUD_PORTA` (default 443), `IDCLOUD_HOST` (default `0.0.0.0`).

### 13.2 No REP

`txtIPCloud` = o IP da VPS. **Não precisa mexer em mais nada:**

- a porta é fixa em 443 e segue o firmware;
- a senha do web server pode ser qualquer uma — passa por `REP_ADMIN_SENHA`;
- o `interval` pode ficar no padrão (2078000). Para testar rápido,
  `POST set_idcloud {"enable":true,"interval":8}`.

### 13.3 No iZCloud

1. A UI (ou curl) reserva a vaga do REP:
   `POST /api/reps/:id/reservar-coleta {"minutos": 30}`
2. O REP conecta. O serviço valida o `nSerie` da vaga, abre sessão, lê e grava.
3. Conferir: `GET /api/reps/:id/coleta` e `GET /api/coletas`.

### 13.4 Segurança — o ponto que exige atenção

**O REP não se apresenta.** Ele abre a conexão e não manda um byte, então não há
como ele provar quem é, e um `login` com `admin/admin` funciona por qualquer um
que chegue na 443. As três camadas, em ordem:

1. **Trava de série** (implementada): a primeira coisa é `get_about.fcgi`, e o
   `nSerie` precisa bater com o REP esperado da vaga. Sem vaga, derruba.
2. **Senha forte** no web server do REP (implementada via `REP_ADMIN_SENHA`):
   sem isso a trava vira só atraso.
3. **Não expor a 443 para a internet inteira** sem a vaga ativa. Uma VPS é
   endereço público; se a 443 estiver aberta, qualquer um chega na trava.

### 13.5 Diagnóstico rápido

```bash
# O REP conectou? (o log do serviço mostra "[idcloud] REP ... conectado")
# Trouxe dados?
curl -H "Authorization: Bearer $TOKEN" $BASE/api/reps/1/coleta

# Ver o que o REP respondeu, comando a comando
node descobre_porta.mjs          # escuta 7 portas e imprime as respostas FCGI
```

Se aparecer `conexao recusada: nenhum REP reservado`, é a trava — chame
`reservar-coleta` antes.

---

## 14. Perguntas em aberto (para a Control iD)

1. **Rotação do AFD.** O aparelho entrega só as primeiras 1000 linhas e ignora
   `offset`. O arquivo rotaciona sozinho quando enche? Com que tamanho? Sem
   isso não temos o histórico completo — é o maior risco do produto.
2. **`get_afd` com data.** Existe parâmetro de período em alguma versão de
   firmware? Testei 10 nomes e nenhum pagina nesta versão (v1048, 2019).
3. **Número curto de iDCloud.** Ele amarra o aparelho a uma empresa no lado do
   Control iD, e só na primeira vez. Como isso se reflete para um servidor
   **próprio**? Provavelmente o número vira o identificador que a nossa UI emite
   ao provisionar o REP, mas é preciso confirmar com o fabricante.
4. **Formato do REP para o iDCloud oficial.** A doc descreve o cliente de
   desktop. Para um servidor próprio, o REP iDClass é o mesmo aparelho com
   `txtIPCloud` apontado para nós — é o que assumimos e funcionou.

---

## 15. Ferramentas de diagnóstico (no repositório)

Todas rodam contra o REP de teste e foram usadas para chegar nas conclusões
acima. Precisam do REP com `txtIPCloud` apontado para `192.168.100.179`.

| Arquivo | Para que serve |
|---|---|
| `captura_rep.mjs` | Escuta 33 portas e grava os bytes crus (`.bin`). Achou a porta 443. |
| `descobre_porta.mjs` | Descobre em que porta o REP disca, e imprime as respostas FCGI. |
| `teste_coleta.mjs` | Prova o canal inteiro: trava, login, usuários, empresa, AFD. |
| `teste_offset.mjs` | Mostra que nenhum parâmetro pagina o AFD. |
| `dump_afd.mjs` | Baixa um AFD e mostra a distribuição de tipos de registro. |
| `ch.mjs` | Lê um `.bin` capturado e extrai SNI, cipher suites, extensões. |

Exigem `cert.pem` e `chave.pem` (gitignored). Para gerar:

```bash
openssl req -x509 -newkey rsa:2048 -keyout chave.pem -out cert.pem -days 30 -nodes \
  -subj "/C=BR/O=iZCloud/CN=SEU_IP" -addext "subjectAltName=IP:SEU_IP"
```

Comandos úteis no REP (o web server dele escuta na porta configurada — 443 no
padrão):

```bash
# login e leitura
curl -k -X POST -H "Content-Type: application/json" \
  -d '{"login":"admin","password":"admin"}' https://192.168.100.132/login.fcgi

# acelerar as tentativas do iDCloud (e restaurar depois)
curl -k -X POST -H "Content-Type: application/json" \
  -d '{"enable":true,"interval":8}' "https://192.168.100.132/set_idcloud.fcgi?session=$SESS"
```

> `load_users` exige `limit` **e** `offset` inteiros. Sem `offset` o aparelho
> responde `'offset' deve ser do inteiro`.
