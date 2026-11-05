# VPS relay L4 para o REP-C (iDClass)

> Objetivo: dar ao REP-C um **IP público fixo na 443** para ele conectar no
> canal iDCloud do iZCloud, sem precisar de IP fixo na Railway.
>
> O iDFace **não usa isso**: ele fala HTTPS outbound (push) direto com a
> Railway. Este relay é só para o REP-C.

## 1. Arquitetura

```text
REP-C (iDClass)                     VPS (IP fixo)                 Railway
txtIPCloud = IP do VPS  ────────►  :443  (socat/nginx stream)  ────────►  zephyr.proxy.rlwy.net:48331
porta fixa 443, TLS 1.2            L4: só encaminha TCP                    │
sem SNI/Host                                                               ▼
                                                              idcloudServer :443
                                                              (TLS + coleta AFD)
```

Por que o VPS:

- o REP-C conecta por **IPv4 literal** e **porta 443 fixa**;
- o TCP Proxy da Railway expõe uma **porta aleatória** (ex.: `48331`), não 443;
- o VPS recebe na 443 (porta que o REP aceita) e repassa para a porta do
  Railway. O VPS **não termina TLS** e não precisa de SNI/Host.

## 2. VPS

Plano barato (ex.: InterServer US$ 3/mês, 1 core, 2 GB, IP estático).
Sistema recomendado: **Ubuntu 22.04/24.04 minimal**.

Acesso:

```bash
ssh root@IP_DO_VPS
```

## 3. Instalar o relay (socat)

```bash
apt update && apt install -y socat
```

Teste manual (deixe rodando e veja o log):

```bash
socat -d -d TCP-LISTEN:443,fork,reuseaddr TCP:zephyr.proxy.rlwy.net:48331
```

Em outro terminal, teste a porta:

```bash
# do seu PC (Windows)
Test-NetConnection IP_DO_VPS -Port 443

# do VPS
openssl s_client -connect IP_DO_VPS:443
```

Se aparecer o certificado do `idcloudServer` (pode ser self-signed), o relay
está chegando na Railway. Se a conexão fechar sem certificado, o canal da
Railway não está ativo (cert/key ou porta) — veja §5.

## 4. Firewall

No VPS:

```bash
ufw allow 22/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

No painel do provedor, libere **TCP 443 de entrada** (security group/firewall).

## 5. Serviço systemd (relay permanente)

Crie `/etc/systemd/system/izcloud-relay.service`:

```ini
[Unit]
Description=iZCloud L4 relay 443 -> Railway TCP proxy
After=network.target

[Service]
ExecStart=/usr/bin/socat -d -d TCP-LISTEN:443,fork,reuseaddr TCP:zephyr.proxy.rlwy.net:48331
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Ative:

```bash
systemctl daemon-reload
systemctl enable --now izcloud-relay
systemctl status izcloud-relay
journalctl -u izcloud-relay -f     # acompanhar conexões
```

## 6. Railway (canal iDCloud)

No serviço do iZCloud, confira as variáveis:

```env
IDCLOUD_PORTA=443
IDCLOUD_BIND=0.0.0.0
IDCLOUD_CERT_PEM=<conteúdo do cert.pem>
IDCLOUD_KEY_PEM=<conteúdo da chave.pem>
```

- O canal só sobe se `IDCLOUD_CERT_PEM` + `IDCLOUD_KEY_PEM` (ou os arquivos
  `cert.pem`/`chave.pem`) existirem.
- O log deve mostrar:

```text
[idcloud] ouvindo 0.0.0.0:443
[idcloud] canal ativo em 443
```

- O **TCP Proxy** da Railway deve apontar para a porta interna **443**
  (ex.: `zephyr.proxy.rlwy.net:48331` → `443`).

Se ainda não tiver certificado, gere um self-signed (o REP não valida a CA):

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout chave.pem -out cert.pem -days 3650 -subj "/CN=izcloud"
```

Cole o conteúdo dos dois arquivos nas variáveis `IDCLOUD_CERT_PEM` e
`IDCLOUD_KEY_PEM` (multiline; o código troca `\n` por quebra de linha).

## 7. Configurar o REP-C

No `REPCONFIG.exe` (ou na tela do REP):

- **iDCloud**: habilitado (`enable=true`);
- **IP do iDCloud**: **IP público do VPS** (IPv4 literal, ex.: `203.0.113.10`);
- não há campo de porta: o firmware usa **443**.

No iZCloud, cadastre o REP:

```json
{
  "serial": "00014003750029470",
  "Nome": "REP iDClass 1510",
  "IpAddress": "192.168.100.132",
  "Porta": 5432,
  "Passcode": "admin",
  "REPType": "1510",
  "ModoConexao": "rep_empurra"
}
```

> `ModoConexao=rep_empurra` evita que o poller tente puxar o REP pela nuvem.
> `IpAddress`/`Porta` continuam úteis para importar empresa/funcionários
> quando o iZCloud estiver na mesma LAN; no modo remoto quem inicia é o REP.

## 8. Testar a coleta

1. No VPS: `journalctl -u izcloud-relay -f` deve mostrar a conexão do IP do REP.
2. Na Railway: os logs do `idcloudServer` devem mostrar o serial e a coleta.
3. No iZCloud:
   - `GET /api/coletas` (estado por REP);
   - `GET /api/afd/arquivos` (AFD bruto salvo);
   - `GET /api/afd/arquivos/:id/download` (baixar).
4. No guia `test_izcloud.mjs`, use a **opção 9** (arquivos salvos). A opção 8
   (pull do REP) não é usada no modo remoto.

## 9. Problemas comuns

| Sintoma | Verificar |
|---|---|
| REP mostra "Falha de Conexão" | firewall do VPS/provedor na 443; serviço `izcloud-relay` ativo |
| `openssl s_client` conecta mas fecha | canal da Railway inativo (cert/key, `IDCLOUD_PORTA`) |
| Relay log mostra conexão, mas não coleta | serial não cadastrado no tenant; `IDCLOUD_AUTOACEITE`; logs da Railway |
| Coleta funciona e para | IP do VPS mudou? (deve ser estático); processo caiu? `systemctl status` |
| AFD não aparece | armazenamento `data/afd` efêmero na Railway; anexe volume ou use `IZCLOUD_AFD_DIR` |

## 10. Segurança

- O relay é um **TCP puro aberto na internet**. O `idcloudServer` tem trava de
  serial: só aceita REP cadastrado. Mantenha os seriais fora de listas públicas.
- Se o IP público do cliente for fixo, restrinja a 443 no firewall do VPS para
  esse IP.
- Monitore `journalctl -u izcloud-relay` e os logs do canal.
- Não use este relay para o MySQL nem para a API; ele é só o canal do REP-C.

## 11. Custo e região

- VPS 1 core / 2 GB / 40 GB / IP estático: ~US$ 3/mês.
- Região US (NYC/Dallas/LA) é suficiente; o AFD é periódico (~1,5 MB).
- Confirme que o provedor permite **TCP 443 de entrada** e **IP estático**.
