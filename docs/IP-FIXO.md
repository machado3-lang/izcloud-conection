# IP fixo e conectividade REP ↔ nuvem

> Decisão de arquitetura pendente. **Leia antes de provisionar qualquer coisa.**
> Referenciado por [`RETOMADA.md`](RETOMADA.md) P2. Snapshot 25/09/2026.

---

## 1. O problema, em uma frase

O REP (iDClass) aponta para a nuvem por **endereço IP fixo** (campo
`configOffSetIPiDCloud` / `txtIPCloud` do `REPCONFIG.exe`), mas o Railway
entrega **domínio, não IP** — e o IP dos containers da Railway muda.

**Detalhe importante:** o problema **não é só** o IP fixo. Os dois modos de
conexão exigem um caminho de rede público, e hoje **nenhum dos dois funciona**.

---

## 2. Requisitos reais (o que o REP impõe)

Extraído do comportamento do `repClient.js` e do protocolo iDClass:

| # | Requisito | Detalhe |
|---|---|---|
| R1 | **Endereço de destino é um IP** | O REPCONFIG grava um IP, não um hostname. *(A confirmar: alguns firmwares aceitam domínio no mesmo campo.)* |
| R2 | **Porta 443, HTTPS** | `proxyREP()` tenta HTTPS primeiro, com fallback HTTP 80. |
| R3 | **Certificado TLS válido e confiável** | O REP tem trust store próprio. Certificado self-signed provavelmente é rejeitado. |
| R4 | **Tráfego entrante** | Para `rep_empurra`, o REP **inicia** a conexão para a nuvem. |
| R5 | **Payload JSON** | O REP fala FCGI: `POST /login.fcgi`, `/get_afd.fcgi`… com JSON no corpo. |
| R6 | **IP estável por anos** | O REP não tem DNS. Se o IP mudar, ele não sabe se reconectar. |

R2+R3+R5 significam que **um proxy L7 (HTTP reverse proxy) com certificado
Let's Encrypt** resolve tudo — não é necessário proxy L4 cru.

---

## 3. Os dois modos de conexão (e por que ambos estão travados)

| Modo | Quem inicia | O que precisa |
|---|---|---|
| `nuvem_puxa` (padrão) | A **nuvem** → `login`, `get_afd` | O REP precisa ser **alcançável a partir da internet** |
| `rep_empurra` | O **REP** → `/api/afd/push` | A nuvem precisa de **IP público fixo** (R1, R4, R6) |

### 3.1 `nuvem_puxa` está travado hoje (e o motivo é contraintuitivo)

O REP de homologação é `192.168.100.132` — **endereço de LAN**. O container na
Railway não alcança esse IP. Não há problema de IP fixo aqui: **não existe
caminho nenhum**.

Para `nuvem_puxa` funcionar, é preciso que o REP sia da LAN para a internet de
alguma forma (ver §5.2). **Não exige IP fixo na nuvem** — só exige que a nuvem
consiga alcançar um endereço estável do lado do REP (domínio serve).

### 3.2 `rep_empurra` exige IP fixo na nuvem

Este é o caso que o usuário levantar é. Aqui sim: sem IP público e estável
para o REP apontar, o modo não sobe. Ver §5.1.

---

## 4. O que já foi tentado

| Tentativa | Resultado |
|---|---|
| **Oracle Cloud Free** (README §12.5) | ❌ Não foi possível criar a conta. |
| **Railway** (README §13) | ✅ Adotado, mas **sem IP fixo** — travou `rep_empurra`. |
| **Cloudflare Spectrum** (README §13.5) | ⚠️ **Proposta original está errada** — ver §6. |

---

## 5. Opções avaliadas

### 5.1 Para `rep_empurra` (IP fixo na frente do app)

#### Opção A — VPS barato como proxy reverso para a Railway  ← **recomendada**
```
REP ──HTTPS 443──▶ [VPS: IP fixo + Caddy/nginx + cert Let's Encrypt]
                         │
                         └──HTTPS──▶ https://izcloud-conection-production.up.railway.app
```
- ✅ IP público fixo real, barato, ~US$ 4–6/mês (provedores: Hetzner, DigitalOcean,
  Vultr, OVH, Contabo, Lightsail — **preços e disponibilidade a verificar**; a conta
  do Oracle falhou antes, então convém testar o cadastro antes de projetar em cima).
- ✅ Certificado TLS válido → resolve R2, R3 e a pendência "TLS em produção".
- ✅ App e MySQL **continuam na Railway** (auto-deploy por push, banco gerenciado).
- ✅ A VPS é burra: só encaminha requisições. Nenhum estado fica lá.
- ⚠️ Custo recorrente e mais uma coisa para manter/monitorar.
- ⚠️ Se a Railway mudar o domínio, atualiza 1 arquivo de config na VPS.

#### Opção B — Migrar tudo para a VPS
MySQL + Node na VPS, com IP fixo. Perde o auto-deploy e o banco gerenciado da
Railway. **Só faz sentido se a Railway ser descartada por outro motivo** — não é
o caso hoje.

#### Opção C — Cloudflare Spectrum
Ver §6. **Não recomendado** para este caso: exige Enterprise.

#### Opção D — Continuar só em `nuvem_puxa`
Deixar `rep_empurra` desativado e resolver o alcance do REP (§5.2). É o caminho
**mais barato** e provavelmente suficiente para o MVP, já que o iZCloud puxa o
AFD por poller de 60s de qualquer forma.

---

### 5.2 Para `nuvem_puxa` (REP na LAN precisa ser alcançável pela nuvem)

O REP é um equipamento fechado: não dá para instalar nada nele. Mas dá para
colocar **um computador/servidor dentro da LAN** que faça a ponte.

| Opção | Como | Custo | Observação |
|---|---|---|---|
| **Port forwarding** | No roteador do cliente, abrir 443 → `192.168.100.132` | 0 | Exige IP público fixo **no cliente** e configuração do roteador. Frágil. |
| **Tailscale / ZeroTier** | Instalar num PC sempre ligado na LAN + `socat` encaminhando para o REP | 0 | Melhor opção grátis. A nuvem alcança o REP pelo IP tailnet. |
| **Cloudflare Tunnel (`cloudflared`)** | Idem, num PC na LAN | 0 | Dá um **domínio** público para o REP. Nuvem alcança por nome, sem IP fixo. |

⚠️ Todos exigem um **PC/servidor sempre ligado dentro da LAN do cliente** —
se o cliente não tem nenhum, isso é uma barreira comercial, não técnica.

---

## 6. Correção: por que o Cloudflare Spectrum do README §13.5 não resolve

O README §13.5 propõe Cloudflare Spectrum como solução para o IP fixo. Pelos
docs oficiais do Spectrum, **a proposta tem dois problemas**:

1. **Aplicações TCP/UDP customizadas exigem plano Enterprise** com Spectrum como
   add-on pago. Planos Pro/Business suportam apenas protocolos selecionados.
2. **Static IP do Spectrum é recurso Enterprise**, sem UI — só via API e com
   contato com o time de vendas.

E o problema que mata a ideia mesmo num plano pago: **por padrão o Spectrum atribui IPs
dinâmicos**, que *podem mudar com o tempo* (a doc oficial diz para consultá-los
via DNS). Um REP com IP fixo no campo de configuração **quebraria silenciosamente
na próxima rotação**. Dynamic edge IPs resolvem o problema de "não ter IP", mas
criam um problema pior para um equipamento sem DNS.

**Conclusão:** Spectrum é a solução certa se você *tiver* Enterprise. Sem ele,
a Opção A (VPS) resolve por uma fração do custo.

---

## 7. Recomendação

**Curto prazo (destrava tudo, custo zero):**
1. Rodar o iZCloud **local na LAN** para validar a biometria no REP de
   homologação (§8). Isso não depende de rede nenhuma.
2. Fazer o deploy `nuvem_puxa` com **Cloudflare Tunnel ou Tailscale** no lado do
   cliente. Sem IP fixo, sem custo.

**Médio prazo (se `rep_empurra` for realmente necessário):**
3. Provisionar a **Opção A** (VPS + Caddy + Let's Encrypt → Railway). ~US$ 4–6/mês.
   Entregar como produto: "o iZCloud te dá um IP fixo para apontar no seu REP".

**Não fazer:** Spectrum sem Enterprise; Oracle Cloud Free (já falhou uma vez).

---

## 8. Como testar sem resolver nada disso

Para validar a **biometria** (P3 do `RETOMADA.md`) — que é a pendência técnica
mais urgente — não é preciso rede pública:

```bash
# na mesma LAN do REP 192.168.100.132
cd C:\Producao\iZCloud
npm install
npm start          # http://localhost:3100, alcançando o REP por IP privado
```

O `repClient.js` fala FCGI direto no `192.168.100.132:443`. Com o iZCloud rodando
na LAN, `POST /api/pessoas/importar` e `POST /api/pessoas/sincronizar` funcionam
hoje, e dá para ajustar `mapearUsuario`/`enviarUsuarios` conforme o firmware real
responder (é exatamente a pendência §12.10 do README).

Só o deploy em nuvem depende do §5.

---

## 9. Lacuna de protocolo a resolver antes de `rep_empurra`

Mesmo com IP fixo, o endpoint `/api/afd/push` **não é alcançável por um REP real**:

- `server.js:130` aplica `app.use('/api/afd', authTenant)` — a rota exige **JWT**
  (web) ou **Basic + `X-Client-DB`** (sistema externo). Um REP não tem nenhum dos dois.
- O protocolo real de push do iDCloud da ControlID (poll de comandos, eventos,
  `X-Device-Serial`) **não está implementado** no iZCloud. Ele existe parecido no
  `idacessoweb/face-cloud` (rota `/push`, `/result`, `/event`) — mas para iDFace,
  não para iDClass 1510/671.

**Pendências daqui para frente:**
1. Descobrir o protocolo de push que o **iDClass 1510/671** realmente fala.
2. Adicionar um caminho de autenticação de **dispositivo** (ex.: token por
   equipamento, header `X-Device-Serial`) para `/api/afd/push`, sem exigir JWT.
3. Só então ligar o `rep_empurra` de verdade.

⚠️ Isso pode tornar `rep_empurra` desnecessário: se o iZCloud já puxa por poller
(`nuvem_puxa`), o ganho do modo empurra é marginal — a não ser que o REP esteja
em site sem saída para a internet.

---

## 10. Referências

- Cloudflare Spectrum — planos e protocolos suportados
- Cloudflare Spectrum — Static IP (recurso Enterprise)
- Cloudflare Spectrum — Configuration options (origem, TLS, proxy duplo)
- `C:\Producao\Gerenciador REPs\REPCONFIG.exe` — gravador de IP no REP
- `C:\Producao\Gerenciador REPs\AFD Downloader\Controlid.iDCloud.DataCloud.dll` —
  referência de formato do protocolo iDCloud oficial (via decompilação)
- `repClient.js` — implementação FCGI do lado do cliente
- `server.js:128-130` — middlewares de auth das rotas `/api/afd`
