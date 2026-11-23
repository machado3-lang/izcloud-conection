# Multi-empregador, multi-REP e envio incremental

> Implementado em 23/11/2026. Substitui o modelo antigo em que “empresa”
> (tenant) e “empregador” eram tratados como a mesma coisa.

## 1. Modelo

```text
Conta/empresa iZCloud (tenant_0001)
  │
  ├── Empregador A (CNPJ/CPF, CEI, razão social)
  │     ├── REP 1 (equipamentos.id_Empregador = A)
  │     ├── REP 2
  │     └── Funcionários (pessoas.id_Empregador = A)
  │           ├── Funcionário 1 ── vinculado a REP 1 e REP 2 (equip_pessoa)
  │           └── Funcionário 2 ── vinculado a REP 2
  │
  └── Empregador B
        ├── REP 3
        └── Funcionários...
```

Regras:

- **1 tenant → N empregadores.**
- **1 empregador → N REPs** (`equipamentos.id_Empregador`).
- **1 empregador → N funcionários** (`pessoas.id_Empregador`).
- **1 funcionário → N REPs** (`equip_pessoa`, muitos-para-muitos).
- O funcionário só pode ser vinculado a REPs **do mesmo empregador** (validado
  no backend e filtrado na UI).
- O **empregador** é o CNPJ/CPF que aparece no AFD/cabeçalho; a **empresa**
  (tenant) é a conta do iZCloud.

## 2. Schema

| Tabela | Campo | Função |
|---|---|---|
| `empregadores` | `DataAtualizacao` | controle de alteração do cadastro |
| `equipamentos` | `id_Empregador` | empregador do REP (já existia) |
| `pessoas` | `id_Empregador` | empregador do funcionário (novo) |
| `equip_pessoa` | `UltimoEnvio` | cursor: quando o funcionário foi enviado àquele REP |

Migração automática em `core.js` (`aplicarMigracoesTenant`):

- adiciona `pessoas.id_Empregador`, `equip_pessoa.UltimoEnvio`,
  `empregadores.DataAtualizacao`;
- cria índice `pessoas.idx_empregador`;
- **backfill**: funcionário já vinculado a um REP herda o empregador do REP.

## 3. API

Empregadores (escopo do tenant):

```text
GET    /api/empregadores                  lista + contagem de REPs/funcionários
POST   /api/empregadores                  { RazaoSocial, CNPJ_CPF, CEI, Local }
PUT    /api/empregadores/:id
DELETE /api/empregadores/:id              só se não estiver em uso
GET    /api/empregadores/:id/pessoas
GET    /api/empregadores/:id/reps
```

Vínculo REP ↔ empregador:

```text
PUT /api/reps/:id/empregador   { id_Empregador }
```

Funcionários:

```text
GET  /api/pessoas?id_Empregador=...       filtra por empregador
POST /api/pessoas                          aceita pessoa.id_Empregador
PUT  /api/reps/:id/funcionarios            { ids: [...] } (valida empregador)
POST /api/pessoas/sincronizar              envia só o que mudou
```

## 4. Envio incremental (funcionários)

- `pessoas.DataAtualizacao` é atualizado em qualquer criação/alteração.
- `equip_pessoa.UltimoEnvio` guarda quando aquele funcionário foi enviado
  àquele REP.
- `POST /api/pessoas/sincronizar` seleciona apenas:

```sql
ep.UltimoEnvio IS NULL OR p.DataAtualizacao > ep.UltimoEnvio
```

- Depois de enviar com sucesso, grava `UltimoEnvio = NOW()`.
- Se não há nada pendente, responde `{ enviados: 0, motivo: 'sem alteracao' }`.
- Salvar a tela de vínculos **não** reenvia todo mundo: `definirVinculos`
  preserva `UltimoEnvio` dos vínculos que continuam e só marca NULL nos novos.

> O primeiro envio de um REP que já foi importado pode mandar todos uma vez
> (os vínculos antigos têm `UltimoEnvio` NULL). Depois disso, só alterações.

## 5. UI

- Nova aba **Empregadores**: CRUD, contagem de REPs/funcionários, editar/excluir.
- Aba **REPs**: cada REP tem um **select de empregador**; o vínculo é salvo na
  hora (`PUT /api/reps/:id/empregador`).
- Aba **Funcionários**:
  - filtro por **empregador**;
  - coluna “Empregador”;
  - o cadastro de funcionário aceita o empregador;
  - ao selecionar um REP, a lista já filtra pelo empregador do REP.
- O cartão do topo é a **conta/empresa do iZCloud**; os empregadores ficam na
  aba **Empregadores**. O antigo botão “Vincular empresa” foi substituído pelo
  select de empregador no REP.

## 6. Fluxos de uso

### 6.1 REP já existente (tem empresa/funcionários/marcações)

1. O REP conecta no canal iDCloud (`rep_empurra`) ou é sondado por IP
   (`nuvem_puxa`).
2. `load_company` + `load_users` importam empregador, funcionários e templates.
3. `pessoas.id_Empregador` é preenchido com o empregador do REP.
4. O AFD é coletado e armazenado.
5. Na UI, o empregador aparece na aba **Empregadores** e no select do REP.

### 6.2 REP novo (cadastrar no iZCloud e enviar)

1. Cadastre o **empregador** na aba Empregadores.
2. Cadastre os **funcionários** com o empregador.
3. Cadastre o REP e selecione o empregador.
4. Vincule os funcionários ao REP (aba Funcionários → selecione o REP →
   marque os funcionários → Salvar).
5. Envie com **“Enviar vinculados”**:
   - envia só quem nunca foi enviado ou mudou;
   - depois marca `UltimoEnvio`.
6. O cadastro do **empregador** no REP é manual:
   - o firmware expõe apenas `load_company` (leitura);
   - configure o empregador no equipamento (`REPCONFIG`) ou importe de um REP
     que já o tenha.
   - O iZCloud mantém o cadastro para gestão, vínculo e geração do AFD 1510.

## 7. Limitações / próxima fase

1. **Envio remoto de funcionários pelo canal iDCloud.**
   Hoje `POST /api/pessoas/sincronizar` envia por **IP/porta**; funciona no
   `nuvem_puxa` (LAN) e falha no `rep_empurra` (nuvem não alcança o REP).
   Próximo passo: durante a conexão do REP no canal, antes do `get_afd`,
   enviar `add_users`/`update_users` dos pendentes e marcar `UltimoEnvio`.
2. **Envio de empregador ao REP.**
   O firmware só expõe `load_company`; não há `set_company`/`add_company`
   documentado/validado. O cadastro no iZCloud é manual e serve para gestão/AFD.
3. **Exclusão de funcionário no REP.**
   `remove_users` existe, mas ainda não há fila de exclusão. Hoje a remoção do
   vínculo (`equip_pessoa`) não remove o usuário do equipamento.
4. **Troca de empregador de um REP já vinculado.**
   A validação impede novos vínculos cruzados, mas vínculos antigos devem ser
   revisados ao trocar o empregador.

## 8. Migração de dados existentes

No boot, `migrarTenantsExistentes()` roda `aplicarMigracoesTenant()` em todos os
tenants ativos. Para o tenant atual:

- adiciona as colunas/índice;
- preenche `pessoas.id_Empregador` a partir do REP vinculado;
- não altera `UltimoEnvio` (o primeiro envio pode mandar todos uma vez).
