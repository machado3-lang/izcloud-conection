# Teste do iZCloud — iDFace + AFD do iDClass

> Guia passo a passo para validar o que foi implementado em 05/11/2026.
> Nada aqui precisa de `curl`: os dois scripts fazem o trabalho.

## Pré-requisitos

- Node.js 18+ no seu PC (o mesmo que já roda os scripts do projeto).
- O iDFace ligado na mesma rede local (o de homologação é `192.168.100.138`).
- URL, login e senha da plataforma iZCloud.
- Uma empresa (tenant) já criada na conta.

## 1. Abrir o guia

No diretório do projeto:

```bash
cd C:\Producao\iZCloud
node test_izcloud.mjs
```

Ele pergunta a URL, o login e a senha. Se você tiver mais de uma empresa, ele
mostra a lista e pede para escolher. No fim, aparece o menu:

```text
1) Status do iZCloud
2) Listar dispositivos iDFace
3) Criar dispositivo iDFace (mostra URL de push)
4) Disparar coleta iDFace (AFD / logs / usuarios)
5) Ver marcacoes do iDFace
6) Baixar AFD bruto do iDFace
7) Listar REPs iDClass
8) Baixar AFD do iDClass (completo / NSR / data)
9) Listar/baixar arquivos AFD salvos
0) Sair
```

## 2. Conferir o status (opção 1)

O script chama `/api/health`, `/api/reps` e `/api/idface/dispositivos`.

- Se `/api/reps` e `/api/idface/dispositivos` responderem, a migração do tenant
  está OK.
- Se der erro de tabela inexistente, o deploy ainda não rodou a migração; veja
  os logs do Railway (`[migracao-tenant]`).

## 3. Criar o dispositivo iDFace (opção 3)

Informe:

- **Nome:** ex.: `iDFace Recepcao`
- **id_Equipamento:** opcional (Enter pula)
- **Portaria:** `671` (CPF) ou `595` (PIS/1510-like)

O script mostra:

```text
id: 1
token: ...
push_base: https://SEU_HOST/api/idface/tenant_0001/TOKEN
push_url : https://SEU_HOST/api/idface/tenant_0001/TOKEN/push
```

## 4. Configurar o push no iDFace

No PC que está na mesma rede do equipamento:

```bash
node config_idface_push.mjs 192.168.100.138 https://SEU_HOST/api/idface/tenant_0001/TOKEN
```

- O script lê a configuração atual, grava a nova e lê de novo para conferir.
- O padrão é **10 segundos** entre polls (bom para teste). Em produção use
  `--period=300`.
- Se o IP do iDFace for outro, troque `192.168.100.138`.
- Para só ver a configuração atual: `node config_idface_push.mjs 192.168.100.138 --show`.

> O firmware acrescenta `/push` e `/result` sozinho. Passe a **base** (sem
> `/push`). Não use `push_attributes` nesse firmware.

## 5. Disparar a coleta (opção 4)

Escolha o dispositivo e:

- **AFD completo** — baixa o arquivo do equipamento (recomendado para o primeiro teste).
- **access_logs** — marcações em tempo real.
- **usuarios** — snapshot de `users` + CPF de `c_users` (para mapeamento).

O comando fica na fila. O iDFace executa no próximo poll (10s no teste).

## 6. Ver as marcações (opção 5)

Escolha o dispositivo e o período (Enter = tudo). A tabela mostra:

```text
Data/hora | Documento | device_user_id | Matricula/PIS | Nome | Origem | NSR
```

- `Documento` é o que veio no AFD (PIS/CPF ou `users.id`).
- `device_user_id` é o `users.id` do equipamento.
- `Matricula/PIS` e `Nome` vêm do snapshot de `users` (quando coletado).

## 7. Baixar o AFD bruto do iDFace (opção 6)

Lista os arquivos em `afd_arquivos`, pergunta o ID e salva no seu PC como
`AFD_idface_<id>.txt`.

## 8. Baixar o AFD do iDClass (opção 8)

Antes, cadastre o REP-C. No menu, use a **opção 10**:

```text
1) Sondar (o servidor do iZCloud precisa alcançar o REP)
2) Cadastrar manual (só o número de série)
```

- **Sondar:** informe IP, porta do web server (443 ou 5432), usuário e senha.
  Se o servidor alcançar o REP, ele preenche serial e portaria.
- **Manual:** informe o número de série (o `nSerie` do REP) e os dados de
  conexão. Serve quando o iZCloud está na nuvem e o REP está atrás do NAT.

Cadastro manual do REP-C de homologação (o que já medimos):

```text
serial: 00014003750029470
Nome:   REP iDClass 1510
IP:     192.168.100.132
Porta:  5432        (porta do web server; o canal iDCloud usa 443 fixa)
Passcode: admin
REPType: 1510
Modo:   nuvem_puxa  (para o teste local; o remoto será rep_empurra/canal)
```

O mesmo corpo via API:

```json
{
  "serial": "00014003750029470",
  "Nome": "REP iDClass 1510",
  "IpAddress": "192.168.100.132",
  "Porta": 5432,
  "Passcode": "admin",
  "REPType": "1510",
  "ModoConexao": "nuvem_puxa"
}
```

Depois, a **opção 8** lista os REPs cadastrados:

- **completo**
- **por NSR** (informe o NSR inicial)
- **por data** (informe `YYYY-MM-DD`)

Salva como `AFD_idclass_<id>_<modo>.txt`.

> **Diferença importante de rede:** o iDFace usa **push HTTPS de saída** (o
> aparelho conecta na nuvem), por isso funciona remoto. O iDClass **não** faz
> esse push HTTP: ou a nuvem precisa **alcançar o IP do REP** (`nuvem_puxa`),
> ou o REP precisa conectar no **canal iDCloud** (`rep_empurra`, que exige
> 443 público/relay). Se o iZCloud está na nuvem e o REP em `192.168.x.x`, a
> opção 8 vai dar timeout.
>
> Para testar o AFD do iDClass **agora**, rode o iZCloud **localmente** na mesma
> rede do REP e use `http://localhost:3100` no `test_izcloud.mjs`. O acesso
> remoto ao REP-C é exatamente o que o VPS/relay L4 vai resolver depois.

> Para **671**, use `formato=671`: o arquivo vem bruto do REP (com CRC). O
> gerador legado `POST /api/afd/export` só monta 1510.

## 9. Conferir os arquivos

Os downloads ficam na pasta do projeto, com prefixo `AFD_` (já ignorados pelo
git). Abra com um editor de texto. O AFD começa com a linha tipo 1 (cabeçalho)
e termina com a linha tipo 9 (trailer).

## Problemas comuns

| Sintoma | O que verificar |
|---|---|
| `401 token invalido` no push | URL configurada no iDFace tem o token certo? |
| `403 deviceId nao confere` | O token já foi usado por outro aparelho; crie outro dispositivo |
| `400 Selecione uma empresa` | O script não conseguiu o `X-Empresa`; escolha a empresa no menu |
| `502 ... Table ... doesn't exist` | Migração do tenant não rodou; veja logs do Railway |
| Coleta não chega | O iDFace está com `push_request_period` correto? A URL é HTTPS válida? |
| AFD bruto some após deploy | No Railway, anexe um volume em `/app/data/afd` (ou use `IZCLOUD_AFD_DIR`) |
| Marcações duplicadas | Você coletou AFD **e** `access_logs`; o campo `origem` separa as duas fontes |

## O que ainda não existe

- Tela no SPA para iDFace (por enquanto, use o script/API).
- Envio de empregador do iZCloud para o REP (o header do AFD bruto continua
  sendo o do equipamento).
- Geração fiscal de AFD 671/AFDT/ACJEF/AEJ: isso é papel do MultiPonto/PTRP.
