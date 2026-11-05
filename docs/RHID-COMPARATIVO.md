# Comparativo iDFace × RHiD — AFD, AFDT, ACJEF e AEJ

> Análise feita em 05/11/2026 a partir da pasta
> `C:\Producao\sistema-de-pontos\teste-idface`, com arquivos gerados pelo
> **iDFace real** (192.168.100.138) e pelo **RHiD** da Control iD.
>
> Objetivo: entender por que o AFD do equipamento saía com `users.id` em vez de
> PIS/CPF e definir a arquitetura correta antes de implementar a coleta no
> iZCloud.

## 1. Resumo executivo

A “charada” está resolvida e a arquitetura está confirmada:

1. **O iDFace é só coletor.** O AFD dele usa sempre `users.id` — nunca
   `users.registration` (PIS) nem `c_users.cpf`. Os formatos 595 e 671 do
   equipamento só mudam o **layout**, não o campo de origem.
2. **O RHiD provisiona o usuário no equipamento com `users.id` = PIS.**
   Antes do RHiD o usuário tinha `id=70175681172`. Depois, o RHiD **apagou**
   esse usuário e criou outro com `id=2613449424` (o PIS `02613449424` sem o
   zero à esquerda). Por isso as marcações novas passaram a sair com PIS no
   AFD do equipamento.
3. **O RHiD gera os arquivos fiscais na nuvem**, não no equipamento. Ele lê as
   marcações, aplica o tratamento do REP-P e emite:
   - **AFD 671** (versão 004) com **CPF** e registros **tipo 5 + tipo 7**;
   - **AEJ 671** com CPF, vínculos, horários, marcações e ausências;
   - **AFDT 1510** e **ACJEF 1510** com **PIS** (compatibilidade).
4. **As 4 primeiras marcações do equipamento foram perdidas** nos arquivos do
   RHiD. Elas usavam o `users.id` antigo (`70175681172`); quando o RHiD apagou e
   recriou o usuário, elas ficaram órfãs. Só as 2 marcações feitas depois, já com
   `id` = PIS, entraram.
5. **O iZCloud não deve reescrever o AFD do equipamento.** Deve coletar as
   marcações, guardar o vínculo antigo → novo e **gerar os arquivos fiscais na
   nuvem** (ou entregar as marcações a um REP-P já certificado).
6. **Gerar arquivo fiscal não é o mesmo que ser REP-P legal.** A Portaria 671
   exige, para REP-P, registro de programa no INPI, assinatura ICP-Brasil e
   Atestado Técnico/Termo de Responsabilidade (arts. 78, 88 e 91). O iZCloud
   pode ser o coletor + PTRP, mas o papel de REP-P precisa ser decidido com
   consciência disso.

## 2. Arquivos analisados

| Arquivo | Origem | Formato real | O que é |
|---|---|---|---|
| `AFD_Report_595_integral_2026-11-05_12-01-29.txt` | iDFace | **AFD 1510-like (“595”)** | 6 marcações tipo 3, documento = `users.id` |
| `AFD_Report_671_integral_2026-11-05_12-00-56.txt` | iDFace | **AFD 671 versão 003** | 6 marcações tipo 3, documento = `users.id` |
| `AFDBR512021002936413133714000110REP_P.txt` | RHiD | **AFD 671 versão 004** | tipo 5 (empregados) + tipo 7 (marcações REP-P), CPF |
| `...REP_P.txt.p7s` | RHiD | Assinatura | assinatura digital do AFD |
| `_4573_955b4ee6-...txt` | RHiD | **AEJ 671** | tipos 01/03/04/05/07/08/99, CPF |
| `AFDT13133714000110REP_A_020261105130305.txt` | RHiD | **AFDT 1510** | tipo 2 (detalhe), PIS, marcações tratadas |
| `ACJEF13133714000110REP_A_020261105130346.txt` | RHiD | **ACJEF 1510** | tipo 3 (resumo diário), PIS |
| `PORTARIA 671-11-2021-REP.pdf` | MTP | Portaria | regras de REP-P, AFD e AEJ |

> **Correção importante:** o arquivo chamado de “AFD 1510” do RHiD **não é
> 1510**. Ele tem data ISO, CPF e registro tipo 7 — é o **AFD 671 versão 004**.
> Na pasta não existe AFD 1510 do RHiD; os artefatos 1510 são o **AFDT** e o
> **ACJEF**. Isso fecha o bloqueio anterior (“não há AFD 1510”).

## 3. O que o equipamento gera

### 3.1 AFD 595 (1510-like)

```text
0000000001100000000000000000000000000ControliD ... 04408801109364847 05112026 05112026 1201 8FF8
00000000130511202610200701756811724A72
00000000230511202610270701756811724D72
00000000330511202610440701756811727789
00000000430511202610450701756811728965
00000000530511202611590026134494240FB6
00000000630511202611590026134494244FBD
9999999990000000000000000060000000000000000000000000009
```

- Cabeçalho tipo 1: empregador **zerado** (`00000000000000`), razão `ControliD`,
  período = dia da exportação.
- 6 marcações tipo 3: `DDMMAAAA` + `HHMM` + documento 12 dígitos + CRC.
- Sem tipo 2 (empregador), sem tipo 5 (empregados) e sem assinatura P7S.
- O trailer é uma linha `999999999...9` (o parser classifica como trailer).

### 3.2 AFD 671 do equipamento

```text
0000000001100000000000000000000000000ControliD ... 2026-11-052026-11-052026-11-05T12:00:00-0400003... 3440
00000000132026-11-05T10:20:00-0400070175681172ADB4
00000000232026-11-05T10:27:00-04000701756811720072
00000000332026-11-05T10:44:00-0400070175681172D036
00000000432026-11-05T10:45:00-0400070175681172FDD7
00000000532026-11-05T11:59:00-0400002613449424D5FC
00000000632026-11-05T11:59:00-0400002613449424CF4C
9999999990000000000000000060000000000000000000000000000000000009
```

- Cabeçalho **versão 003**, empregador zerado, desenvolvedor Control iD.
- Ainda usa **tipo 3** (não tipo 7): o equipamento não se declara REP-P.
- Documento = `users.id` com 12 dígitos (zero à esquerda + 11 dígitos).
- Sem tipo 5 (empregados), sem tipo 7 (marcação REP-P), sem P7S.

### 3.3 O que isso prova

| Pergunta | Resposta |
|---|---|
| O AFD do equipamento usa `registration` (PIS)? | **Não.** |
| Usa `c_users.cpf`? | **Não.** |
| Usa `users.id`? | **Sim**, nos dois formatos. |
| 595 e 671 diferem no campo de origem? | **Não.** Só no layout (data/PIS × ISO/CPF). |
| O AFD do equipamento tem valor legal? | **Não.** O próprio aviso do equipamento diz isso. |

## 4. O que o RHiD fez no equipamento

Leitura somente-leitura do iDFace **depois** do RHiD:

```json
// users (agora)
{
  "id": 2613449424,
  "registration": "2",
  "name": "ANTONIO TESTE RHID",
  "user_type_id": 0
}

// c_users (agora)
{ "c_users": [] }
```

Comparação antes/depois:

| Campo | Antes do RHiD | Depois do RHiD |
|---|---|---|
| `users.id` | `70175681172` | **`2613449424`** (= PIS sem zero à esquerda) |
| `users.registration` | `02613449424` (PIS) | **`2`** (matrícula interna do RHiD) |
| `users.name` | `ANTONIO TESTE` | `ANTONIO TESTE RHID` |
| `c_users.cpf` | `19373613065` | **vazio** |
| AFD do equipamento | documento `70175681172` | documento `02613449424` (PIS) |

Ou seja: o RHiD **apagou o usuário antigo e criou outro** com `id` = PIS. Não
foi uma alteração de `registration`; foi troca de identidade do usuário no
equipamento. É exatamente isso que explica as marcações novas com PIS.

Consequência: **as marcações antigas ficaram órfãs**. O vínculo
`70175681172 → funcionário` deixou de existir no equipamento e o RHiD não tinha
como atribuí-las a ninguém.

## 5. O que o RHiD gera na nuvem

### 5.1 AFD 671 (versão 004)

```text
000000000111313371400011000000000000000ACF MACHADO ... 2026-11-012026-11-052026-11-05T13:04:00-0300004 108238299000129 ... 105c
00000004352026-11-05T12:34:00-0300A048998222191TESTETESTE ... f724
00000004452026-11-05T12:34:00-0300A011111111111Teste celular ... c7ac
00000004552026-11-05T12:35:00-0300A020609871743LILIAN YARA SILVA GALVAO ... fc60
00000004652026-11-05T12:35:00-0300A000000203311IDCLOUD ... 99c5
00000004752026-11-05T12:35:00-0300A023732618567ESTHER CHRISTNE S. PERALTA ... d999
00000004852026-11-05T12:35:00-0300A016089115453AGDA DA SILVA GONCALVES ... 4ae9
00000004952026-11-05T12:36:00-0300I019373613065ANTONIO TESTE RHID ... 9134
00000005052026-11-05T12:54:00-0300A019373613065ANTONIO TESTE RHID ... 8542
00000005172026-11-05T11:59:00-04000193736130652026-11-05T12:59:00-0300040 69bc375f...
00000005272026-11-05T11:59:00-04000193736130652026-11-05T12:59:00-0300040 937bd953...
9999999990000000000000000000000000000000000080000000000000000029
ASSINATURA_DIGITAL_EM_ARQUIVO_P7S
```

Campos relevantes:

- Cabeçalho: CNPJ `13133714000110`, razão `ACF MACHADO`, período
  `2026-11-01` a `2026-11-05`, geração `2026-11-05T13:04:00-0300`,
  **versão 004**, CNPJ do desenvolvedor Control iD, CRC.
- Tipo 5: empregados com CPF de 12 dígitos (zero à esquerda), nome, operação
  `I` (inclusão) ou `A` (alteração) e hash.
- Tipo 7: marcações REP-P com:
  - `DH marcação` no fuso do equipamento (`11:59:00-0400`);
  - CPF de 12 dígitos (`019373613065`);
  - `DH gravação` no fuso do servidor (`12:59:00-0300` — mesmo instante);
  - coletor (`04`), indicador on/off e **hash SHA-256**.
- Trailer com contadores por tipo e assinatura P7S externa.

**O AFD 671 do RHiD não tem tipo 3.** Ele usa tipo 7 porque o RHiD é REP-P. O
equipamento usa tipo 3 porque é apenas coletor (REP-C/REP-A-like).

### 5.2 AEJ 671

```text
01|1|13133714000110|||ACF MACHADO|2026-11-01|2026-11-05|2026-11-05T13:04:00-0300|002
03|1|16089115453|AGDA DA SILVA GONCALVES
03|2|20609871743|LILIAN YARA SILVA GALVAO
03|3|23732618567|ESTHER CHRISTNE S. PERALTA
03|4|00000203311|IDCLOUD
03|5|01234567890|teste novo
03|6|11111111111|Teste celular
03|7|48998222191|TESTETESTE
03|8|19373613065|ANTONIO TESTE RHID
04|9|480|0800|1200|1300|1700
05|8|2026-11-05T11:59:00-0400|4|D|0|O|9|Entrada duplicada
05|8|2026-11-05T11:59:00-0400|4|D|1|O|9|Entrada sem saída
07|8|1|2026-11-01||
...
08|RHID|26.10.6.|1|08238299000129|CONTROLID ...|rhid@controlid.com.br
99|1|0|8|1|2|0|9|1
ASSINATURA_DIGITAL_EM_ARQUIVO_P7S
```

- `01` cabeçalho; `03` vínculos (8); `04` horário contratual; `05` marcações;
  `07` ausências/banco de horas; `08` PTRP; `99` trailer.
- As 2 marcações foram tratadas como **`D` (desconsideradas)**:
  `Entrada duplicada` e `Entrada sem saída`. Isso é tratamento do REP-P, não
  coleta bruta.
- O AEJ inclui `teste novo` (`01234567890`), que **não** aparece no AFD tipo 5.

### 5.3 AFDT 1510

```text
0000000011113133714000110000000000000ACF MACHADO ... 0111202605112026051120261303
000000002205112026115900261344942400000000000000000D00OEntrada duplicada
000000003205112026115900261344942400000000000000000D01OEntrada sem saída
0000000049
```

- Tipo 2: data `DDMMAAAA`, hora `HHMM`, PIS `02613449424`, REP de 17 dígitos,
  tipo de marcação `D`, sequencial `00/01`, origem `O`, motivo.
- Mesmas 2 marcações, agora com **PIS** e já tratadas.

### 5.4 ACJEF 1510

```text
0000000011113133714000110000000000000ACF MACHADO ... 0111202605112026051120261303
000000002200090800170012001300
000000003300261344942401112026000000000000000000000000 00000000 00000000 00000000 000010000
...
0000000089
```

- Tipo 2: horário contratual `0009` (08:00–12:00 / 13:00–17:00).
- Tipo 3: resumo diário por PIS de 01/11 a 05/11. Como as marcações foram
  desconsideradas, não há horas válidas de jornada.
- O empresa/CNPJ vêm do cadastro do RHiD, não do equipamento.

## 6. Marcação por marcação

| # | Equipamento (data/hora) | Documento no equipamento | Origem do documento | No AFD 671 do RHiD? | No AEJ/AFDT? |
|---|---|---|---|---|---|
| 1 | 05/11 10:20 | `70175681172` | `users.id` antigo | **Não** | **Não** |
| 2 | 05/11 10:27 | `70175681172` | `users.id` antigo | **Não** | **Não** |
| 3 | 05/11 10:44 | `70175681172` | `users.id` antigo | **Não** | **Não** |
| 4 | 05/11 10:45 | `70175681172` | `users.id` antigo | **Não** | **Não** |
| 5 | 05/11 11:59 | `02613449424` | `users.id` novo (= PIS) | **Sim** (CPF) | **Sim** (PIS/CPF) |
| 6 | 05/11 11:59 | `02613449424` | `users.id` novo (= PIS) | **Sim** (CPF) | **Sim** (PIS/CPF) |

As 4 primeiras marcações existem no equipamento, mas **não existem em nenhum
arquivo fiscal do RHiD**. É perda de dado por troca de identidade do usuário.

## 7. Por que 595 e 671 saíam iguais antes

Porque o gerador de AFD do equipamento **não escolhe entre PIS e CPF**: ele
sempre escreve `users.id`. O “595” e o “671” são apenas dois layouts do mesmo
relatório:

| | 595 (1510-like) | 671 |
|---|---|---|
| Data/hora | `DDMMAAAA` + `HHMM` | `YYYY-MM-DDTHH:MM:SS±ZZZZ` |
| Documento | 12 dígitos (zero + `users.id`) | 12 dígitos (zero + `users.id`) |
| Tipo de registro | 3 | 3 |
| CRC | sim | sim |
| Empregador | zerado | zerado |
| Tipo 5/7 | não | não |
| Assinatura | não | não |

Quem dá semântica fiscal ao documento é o **software**, não o equipamento.

## 8. Diferenças de leiaute entre os arquivos

| Arquivo | Portaria | Documento | Registros | Empregador | Assinatura |
|---|---|---|---|---|---|
| AFD do equipamento (595) | 1510-like | `users.id` | 1, 3, 9 | zerado | não |
| AFD do equipamento (671) | 671 v003 | `users.id` | 1, 3, 9 | zerado | não |
| AFD do RHiD | **671 v004** | **CPF** | 1, **5**, **7**, 9 | CNPJ real | P7S |
| AFDT do RHiD | **1510** | **PIS** | 1, **2**, 9 | CNPJ real | não no arquivo |
| ACJEF do RHiD | **1510** | **PIS** | 1, **2**, **3**, 9 | CNPJ real | não no arquivo |
| AEJ do RHiD | **671** | **CPF** | 01, 03, 04, 05, 07, 08, 99 | CNPJ real | P7S |

Detalhes que o iZCloud precisa implementar:

- **AFD 671**: tipo 5 (empregados) e tipo 7 (marcações REP-P) com hash SHA-256;
  trailer com contadores; assinatura P7S.
- **AFDT 1510**: tipo 2 com PIS, REP de 17 dígitos, marcação E/S/D, sequencial
  por jornada, origem O/I/P e motivo.
- **ACJEF 1510**: tipo 2 (horário contratual) e tipo 3 (resumo diário com horas
  normais, noturnas, extras, faltas, sinal de compensação etc.).
- **AEJ 671**: tipos 01/02/03/04/05/06/07/08/99, delimitados por `|`, com
  vínculos, horário contratual, marcações tratadas, ausências e PTRP.

## 9. Contagem de funcionários: 7 × 8

| Fonte | Quantidade | Quem |
|---|---|---|
| AFD 671 do RHiD (tipo 5) | **8 registros / 7 CPFs distintos** | os 7 abaixo + ANTONIO com `I` e `A` |
| AEJ 671 (tipo 03) | **8 vínculos** | os 7 + `teste novo` (`01234567890`) |

O `teste novo` aparece no AEJ mas **não** no AFD tipo 5. Isso é esperado se ele
não teve evento de cadastro no período ou não foi provisionado no equipamento:
o tipo 5 do AFD registra **eventos de empregado** (inclusão/alteração/exclusão),
enquanto o tipo 03 do AEJ lista **todos os vínculos do período**. Não é
necessariamente erro, mas precisa ser confirmado com o RHiD.

Os outros 7 CPFs do AFD: `48998222191`, `11111111111`, `20609871743`,
`00000203311` (IDCLOUD), `23732618567`, `16089115453`, `19373613065`.
Nenhum deles é o PIS `02613449424`.

## 10. Tratamento REP-P (o que o RHiD fez e o iZCloud precisará fazer)

As duas marcações de 11:59 foram **desconsideradas**:

- `Entrada duplicada` (duas entradas no mesmo minuto, sem saída);
- `Entrada sem saída` (entrada sem par de saída).

Isso mostra que o REP-P não é só “guardar batidas”: ele precisa de jornada,
horário contratual, regra de pareamento e marcação de inconsistências. É o
motor que já existe em `sistema-de-pontos/ponto-web/src/engine/`
(`punch.js`, `calculator.js`, `schedule.js`, `inconsistencies.js`,
`justification.js`, `absence.js`, `overtime.js`, `night.js`, `bank.js`,
`dsr.js`).

## 11. Conclusão de arquitetura (confirmada em 05/11/2026)

### 11.1 Papéis

```text
iDFace (coletor)                iZCloud (coleta + cadastro + AFD)          REP-P / PTRP do cliente
────────────────                ─────────────────────────────────          ──────────────────────
users.id = PIS (recomendado)    guarda marcações brutas                    trata jornada
access_logs / export_afd  ───►  mantém device_user_map                ───►  gera AFD/AFDT/ACJEF/AEJ
                                importa funcionários                       assina P7S
                                guarda o AFD bruto e disponibiliza
                                por completo / NSR / data
```

Decisão do projeto:

- **iZCloud é sempre o coletor e o repositório**, tanto do iDFace quanto do
  iDClass (REP-C).
- **iDFace:** o iZCloud coleta e armazena as marcações e o AFD bruto para
  alimentar o **MultiPonto** e outros softwares de ponto, inclusive o futuro
  software de controle de acessos.
- **iDClass (REP-C):** o iZCloud permite cadastrar empregador, funcionários e
  REPs, e disponibiliza o **AFD completo, por NSR ou por data inicial** para
  download/importação em qualquer sistema de ponto do cliente.
- **O REP-P/PTRP é do cliente** (MultiPonto ou outro software). O iZCloud não
  assume o papel de REP-P nem emite os arquivos fiscais tratados
  (AFD 671/AFDT/ACJEF/AEJ); ele apenas disponibiliza o **AFD bruto do REP-C**
  (1510/671) para download, que é o arquivo-fonte.
- **Não reescrever o AFD do equipamento.** Ele é o documento bruto do coletor.
  O iZCloud deve armazená-lo como veio, para auditoria e download.
- **Decidir quem é o REP-P**: o iZCloud pode ser só coletor/PTRP e mandar as
  marcações para um REP-P certificado (recomendado no curto prazo), ou o
  `sistema-de-pontos` pode assumir o papel. Gerar o arquivo no formato certo é
  necessário, mas não substitui INPI + ICP-Brasil + Atestado Técnico.

### 11.2 O iZCloud como ponte (REP-C e REP-P)

O iZCloud é a **ponte/repositório** entre os REPs e os sistemas de ponto:

- **REP-C (iDClass):** o iZCloud faz o papel do antigo **Gerenciador de REPs**
  da ControlID — cadastro de empregador, funcionários e REPs, e
  **download/exportação do AFD a distância** (completo, por NSR ou por data)
  para o cliente integrar **manualmente** ao sistema de ponto dele.
- **REP-P (iDFace e futuros):** o iZCloud coleta e armazena as marcações e o
  AFD bruto e expõe API (`/api/idface/marcacoes`, `/api/idface/arquivos`) para
  o **MultiPonto** e outros PTRPs.
- **MultiPonto:** é o **PTRP/REP-P** que trata os arquivos dos dois tipos de REP
  (C e P). Futuramente será registrado no INPI e terá assinatura digital. O
  iZCloud **não** substitui esse papel.

### 11.3 Estratégia de identidade do usuário no equipamento

O RHiD usa `users.id` = PIS. Isso tem prós e contras:

- **Pró:** o AFD 595 do equipamento já sai com PIS, compatível com 1510.
- **Contra:** um único `users.id` não serve para PIS e CPF ao mesmo tempo; para
  671 o RHiD precisa gerar o arquivo na nuvem (e gera).
- **Contra:** trocar `users.id` quebra o vínculo das marcações antigas.

Recomendação para o iZCloud:

1. Provisionar `users.id` = PIS **desde o início** (não trocar depois).
2. Guardar `device_user_id` + `employee_id` em uma tabela de vínculo com
   vigência (`valid_from`/`valid_to`), nunca sobrescrever.
3. Antes de qualquer reprovisionamento, **coletar e persistir todas as
   `access_logs`** e o AFD bruto.
4. Mapear o documento da marcação para o funcionário por:
   `device_user_id` → vínculo → funcionário → PIS/CPF.
5. Se o equipamento permitir, manter também `registration` = PIS e o CPF em
   campo customizado, mas **não depender disso** para o AFD.

### 11.4 Ingestão

Duas fontes, ambas já validadas no equipamento real:

- **Push** (preferencial): enfileirar `load_objects {object:'access_logs'}` ou
  `export_afd`; receber no `/result`; salvar bruto + importar.
- **Pull direto** (LAN): `export_afd.fcgi` / `load_objects` via `idfaceClient`.

O push não manda serial nem `iDCloud_code`; usar token no path
(`/api/idface/<token>/push`) + `deviceId` estável.

## 12. Modelo de dados mínimo (proposta)

| Tabela | Função |
|---|---|
| `idface_devices` | token, `device_id`, serial, `iDCloud_code`, empresa, modo (595/671) |
| `idface_device_users` | vínculo `device_user_id` ↔ `funcionario_id`, `valid_from`, `valid_to`, `origem` |
| `idface_marcacoes_raw` | marcação bruta: device, `device_user_id`, DH, NSR, documento, arquivo de origem |
| `idface_arquivos` | AFD bruto (595/671), hash, tamanho, período, assinatura |
| `idface_comandos` / `idface_resultados` | fila de push e auditoria de execução |
| `funcionarios` | PIS, CPF, nome, empresa, horário contratual |
| `afd_fiscal` / `aej_fiscal` | arquivos fiscais gerados + hash + assinatura |

Regra de ouro: **nunca apagar marcação**. Se o usuário do equipamento mudar,
fechar o vínculo antigo (`valid_to`) e abrir um novo; as marcações antigas
continuam apontando para o vínculo antigo.

## 13. Riscos e armadilhas

1. **Troca de `users.id`** → marcações órfãs (aconteceu no RHiD: 4 batidas
   perdidas). Resolver com vínculo versionado e coleta antes da troca.
2. **NSR local × global**: o equipamento numera de 1 a 6 por arquivo. O RHiD
   renumera globalmente (43..52). O iZCloud precisa de um NSR próprio, estável e
   único por empresa/equipamento.
3. **Fuso horário**: a marcação vem `-0400`; o RHiD grava `-0300` (mesmo
   instante). Guardar sempre UTC + fuso de origem; não comparar strings.
4. **CRC/hash/assinatura**: o AFD do equipamento tem CRC; o do RHiD tem CRC +
   SHA-256 no tipo 7 + P7S. Implementar e testar contra os arquivos reais.
5. **Tipo 3 × tipo 7**: no 671, REP-C/REP-A usa tipo 3; REP-P usa tipo 7. O
   iZCloud, como nuvem, deve emitir tipo 7.
6. **Contagem de funcionários**: AFD tipo 5 (eventos) ≠ AEJ tipo 03 (vínculos).
   Não usar um para validar o outro sem entender o escopo.
7. **Legal**: REP-P exige INPI, ICP-Brasil e Atestado Técnico (arts. 78/88/91).
   Um gerador de arquivo não torna o sistema REP-P homologado.
8. **AFDT/ACJEF 1510 no RHiD**: são compatibilidade. O REP-P está em 671; os
   arquivos 1510 usam PIS do cadastro. O iZCloud deve decidir se emite os dois
   conjuntos ou só o da portaria ativa.
9. **Empregador no AFD do iDClass**: o header vem do REP. O iZCloud cadastra o
   empregador para gestão, mas ainda não envia um comando de empresa ao REP
   (`load_company` é leitura; `add_company` não foi documentado/validado). O
   cadastro precisa existir no REP ou ser importado dele.

## 14. O que já existe e o que falta

| Peça | Onde | Estado |
|---|---|---|
| Parser AFD 1510/671 (tipo 3) | `iZCloud/afd.js` | ✅ corrigido para o 671 do iDFace |
| Parser AFD 671 tipo 5/6/7 | `sistema-de-pontos/ponto-web/src/engine/afd.js` | ✅ referência pronta |
| Motor de tratamento (jornada, inconsistências, extras, noturno, banco) | `sistema-de-pontos/ponto-web/src/engine/` | ✅ referência pronta |
| Gerador de AFD do iDFace | `sistema-de-pontos/ponto-cloud/server.js` §635 | ⚠️ brinquedo: sem CRC, sem tipo 2/5/7, layout 671 errado |
| Gerador AFDT/ACJEF 1510 | — | ❌ não existe |
| Gerador AEJ 671 | — | ❌ não existe |
| Gerador AFD 671 tipo 5/7 + hash | — | ❌ não existe |
| Assinatura P7S / ICP-Brasil | — | ❌ não existe |
| Push server oficial | `iZCloud` | ❌ ainda não implementado |
| Importação de funcionários do iDFace | `iZCloud` | ⚠️ manual/parcial |

## 15. Próximos passos

1. **Confirmar com o RHiD** por que `teste novo` está no AEJ e não no AFD tipo 5
   (e se o AFD 1510 existe em outra exportação).
2. **Coletor iDFace no iZCloud** (implementado nesta sessão):
   - `POST /api/idface/dispositivos` gera token e URL de push;
   - `GET/POST /api/idface/<schema>/<token>/push|result` (protocolo oficial);
   - `POST /api/idface/dispositivos/:id/coletar` enfileira `export_afd`
     (completo/NSR/data) ou `load_objects` (`access_logs`/`users`);
   - `GET /api/idface/marcacoes` e `GET /api/idface/arquivos` para o MultiPonto
     e outros sistemas.
3. **Provedor de AFD do iDClass** (implementado nesta sessão):
   - `POST /api/afd/coletar` com `modo = completo | incremental | nsr | data`;
   - `GET /api/afd/download` (baixa direto com o filtro pedido);
   - `GET /api/afd/arquivos` e `GET /api/afd/arquivos/:id/download`;
   - o AFD bruto é guardado em `data/afd/<schema>/` (volume no docker-compose).
4. **Vínculo versionado** `device_user_id` ↔ funcionário
   (`idface_vinculos`, `valid_from`/`valid_to`) para não perder marcações quando
   o `users.id` mudar.
5. **Definir o contrato de ingestão** para o REP-P do cliente (MultiPonto):
   empresa, funcionário (PIS/CPF), `device_user_id`, DH local/UTC, NSR, fonte.
6. **Testar no ambiente real** (Railway/Cloudflare) com o iDFace e com o REP
   iDClass de homologação.
7. Só depois voltar ao iDClass remoto e ao VPS de $3 para o relay L4.
