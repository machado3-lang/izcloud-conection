# Protocolos Control iD — o que é oficial, o que descobrimos, o que falta

Documento de referência para a integração do iZCloud com os equipamentos Control iD.
Fontes: documentação oficial da Control iD e análise do firmware `fw.bin` do REP iDClass.

**Data da análise:** 26/09/2026
**Repositório:** `izcloud-conection` · **Alvo de deploy:** Railway (sem IP público fixo)

---

## 1. Resumo executivo (leia isto primeiro)

| Equipamento | Protocolo | Precisa de IP público fixo? | railway funciona? |
|---|---|---|---|
| **iDFace / iDFlex / iDAccess / coletor** | API REST oficial: **Push** + **Monitor** | **Não** — aceita **domínio** | **Sim** |
| **REP iDClass 1510 / 671** | Canal iDCloud (TLS) para um servidor iDCloud | **Sim** — o campo aceita **só IP numérico** (testado) | **Não** |

Consequência prática: **o iZCloud na Railway cobre iDFace/iDFlex/coletor hoje.** Para o
REP iDClass é necessária uma **VPS com IP fixo** (ver §7). O agente local foi
descartado por decisão do dono do produto (não queremos software na máquina do cliente).

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

### 4.3 O canal é TLS/HTTPS, não MySQL bruto

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

### 4.4 Reconciliação com a documentação do iDCloud

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

## 9. Referências

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