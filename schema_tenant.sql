-- schema_tenant.sql - Tabelas de UM cliente (executado dentro do schema tenant_XXXX)
-- Sem CREATE DATABASE / USE: o core cria o schema e roda este script dentro dele.
-- Espelha o modelo iDCloud (ControlID), confinado ao tenant.

-- Equipamentos (REPs). No iDCloud e' SOMENTE LEITURA pelo REP.
-- REGRA IMPORTANTE: id_Equipamento e' o identificador com que o REP se reconhece
-- ao ler esta tabela (a doc oficial diz "numero de serie"). CUIDADO com o tipo:
-- um serial real tem 17 digitos (ex.: 00014003750029470) e NAO caberia em INT
-- (2.147.483.647). Por isso BIGINT. `Serial` guarda a string exata, com os
-- zeros a esquerda, para conferencia.
CREATE TABLE IF NOT EXISTS equipamentos (
  id_Equipamento BIGINT PRIMARY KEY,
  Serial VARCHAR(32),        -- nSerie como texto, zeros preservados
  id_Empregador INT,
  Nome CHAR(50),
  utc_Equipamento INT,
  AplicaHorarioVerao BIT,
  statusPapel CHAR(50),
  qtdePessoas INT,
  qtdeDigitais INT,
  IpAddress VARCHAR(50),
  Porta INT,
  Passcode VARCHAR(100),
  REPType CHAR(4),            -- '1510' ou '671' (auto-detectado ou manual)
  ModoConexao ENUM('nuvem_puxa','rep_empurra') DEFAULT 'nuvem_puxa',
        -- nuvem_puxa: iZCloud PUXA do REP (FCGI IP-direto, poller 60s)
        -- rep_empurra: REP EMPURRA para a nuvem (exige IP fixo/Cloudflare;
        --   o poller NAO puxa e os dados chegam via POST /api/afd/push)
  DataAtualizacao DATETIME
);

-- Empregador (a razao social que o REP exibe no ticket).
CREATE TABLE IF NOT EXISTS empregadores (
  id_Empregador INT AUTO_INCREMENT PRIMARY KEY,
  RazaoSocial VARCHAR(50),
  Local VARCHAR(100),
  CNPJ_CPF VARCHAR(20),
  CEI VARCHAR(20),
  CPF VARCHAR(20)
);

-- Departamentos: filtro de para quem o REP envia cada pessoa.
-- 'todos' = 1 faz quem estiver sem departamento ir para TODOS os equipamentos.
CREATE TABLE IF NOT EXISTS departamentos (
  id_departamento INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(50),
  todos BIT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS departamentos_equip (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_departamento INT NOT NULL,
  id_Equipamento BIGINT NOT NULL,
  UNIQUE KEY uq_dep_equip (id_departamento, id_Equipamento)
);

-- Para tenants ja criados (sem a coluna), rode:
-- ALTER TABLE equipamentos ADD COLUMN ModoConexao ENUM('nuvem_puxa','rep_empurra') DEFAULT 'nuvem_puxa';

-- People/Employees. PIS and CPF coexist (confirmed in the AFD Downloader).
-- Contract iDCloud: DataAtualizacao e' o CURSOR de sincronizacao - sem
-- atualiza-lo, a mudanca nunca chega ao aparelho.
-- Excluido      = sai do aparelho, mas continua visivel (inativo) na interface
-- ExcluidoDefinitivo = some do aparelho E da interface
CREATE TABLE IF NOT EXISTS pessoas (
  id_pessoa INT AUTO_INCREMENT PRIMARY KEY,
  PIS BIGINT,
  CPF BIGINT,
  Nome VARCHAR(52),
  Codigo INT,
  Senha VARCHAR(6),
  Matricula INT,
  Admin BIT,
  Rfid BIGINT,
  Barras VARCHAR(15),
  Excluido BIT DEFAULT 0,
  ExcluidoDefinitivo BIT DEFAULT 0,
  DataAtualizacao DATETIME,
  id_departamento INT,
  INDEX idx_pis (PIS),
  INDEX idx_cpf (CPF),
  INDEX idx_dep (id_departamento),
  INDEX idx_atualizacao (DataAtualizacao),
  -- Regra do Inmetro citada na doc do iDCloud: "nao deve existir dois cartoes
  -- (RFID) na tabela pessoas com o mesmo numero". Varios NULL sao permitidos
  -- pelo MySQL, entao quem nao tem cartao nao e afetado.
  UNIQUE KEY uq_rfid (Rfid)
);

-- Para tenants que ja existem (podem ter RFID repetido), quem cria o indice e
-- aplicarMigracoesTenant() em core.js - ele so cria se nao houver duplicados, e
-- avisa no log caso haja, em vez de falhar.

-- Vinculo pessoa x equipamento
CREATE TABLE IF NOT EXISTS equip_pessoa (
  id_Pessoa INT,
  id_Equipamento BIGINT,
  PRIMARY KEY (id_Pessoa, id_Equipamento)
);

-- AFD (somente leitura pela nuvem; o REP escreve). Dado = linha crua.
-- UNIQUE (id_Equipamento, NSR) garante idempotencia do ON DUPLICATE KEY UPDATE
-- (sem isso, sincronizacoes repetidas duplicariam marcacoes).
CREATE TABLE IF NOT EXISTS afd (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_Equipamento BIGINT NOT NULL,
  PIS BIGINT,
  NSR INT NOT NULL,
  Data DATETIME,
  Tipo INT,
  Dado VARCHAR(300),
  CRC CHAR(4),
  UNIQUE KEY uq_afd (id_Equipamento, NSR),
  INDEX idx_equip (id_Equipamento),
  INDEX idx_data (Data)
);

-- Para bancos de tenant ja criados antes desta correcao, rode (apos remover
-- duplicados de (id_Equipamento, NSR), se houver):
-- ALTER TABLE afd ADD COLUMN id BIGINT AUTO_INCREMENT PRIMARY KEY FIRST,
--   ADD UNIQUE KEY uq_afd (id_Equipamento, NSR);

-- Marcacoes parseadas (opcional, para apuracao na nuvem)
CREATE TABLE IF NOT EXISTS marcacoes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_Equipamento BIGINT,
  documento VARCHAR(20),    -- PIS ou CPF conforme o REP
  tipo_registro CHAR(1),
  data DATETIME,
  dado TEXT,
  nsr INT,
  crc CHAR(4)
);

-- Controle de sincronizacao incremental por equipamento (NSR)
CREATE TABLE IF NOT EXISTS sync_status (
  id_Equipamento BIGINT PRIMARY KEY,
  last_nsr INT DEFAULT 0,
  last_sync DATETIME,
  ativo BOOLEAN DEFAULT 1
);

-- Biometric templates (fingerprints and faces) per person.
-- One row per template. iDCloud contract: columns (id_Pessoa, Template), with
-- Template being the base64 string. `Template` is kept in sync with `dados`
-- so the REP finds the column it expects - write paths are centralized in
-- IdCloudClient.gravarTemplate().
-- Column names in MySQL are case-insensitive, so `id_pessoa` answers to the
-- `id_Pessoa` the documentation uses.
CREATE TABLE IF NOT EXISTS templates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_pessoa INT NOT NULL,
  tipo VARCHAR(20),        -- 'digital' | 'face'
  indice INT,              -- finger (1..10) or face slot
  dados LONGTEXT,
  Template LONGTEXT,       -- iDCloud: base64 template (mirror of dados)
  DataAtualizacao DATETIME,
  UNIQUE KEY uq_tpl (id_pessoa, tipo, indice),
  KEY idx_pessoa (id_pessoa)
);

-- Para tenants ja criados (sem a tabela), rode:
-- CREATE TABLE templates ( id BIGINT AUTO_INCREMENT PRIMARY KEY, id_pessoa INT NOT NULL,
--   tipo VARCHAR(20), indice INT, dados LONGTEXT, DataAtualizacao DATETIME,
--   UNIQUE KEY uq_tpl (id_pessoa, tipo, indice), KEY idx_pessoa (id_pessoa) );

-- Estado da coleta pelo canal iDCloud, uma linha por REP.
-- O REP nao empurra nada: ele so abre a conexao e espera. Quem conduz somos nos
-- (ver idcloudServer.js). Sem esta tabela nao ha como mostrar na UI "qual REP
-- ja sincronizou, ate qual NSR, e qual foi o ultimo erro" - que e' justamente
-- o que o operador precisa para saber se o canal esta vivo.
--
-- `ultimo_nsr` e' o cursor: na proxima coleta pedimos o AFD a partir dele, para
-- nao reprocessar o arquivo inteiro a cada conexao.
CREATE TABLE IF NOT EXISTS rep_coletas (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  -- id_Equipamento = serial do REP (17 digitos): nao cabe em INT.
  id_reps         BIGINT NOT NULL,
  serial          VARCHAR(32),
  ultimo_nsr      INT,                  -- maior NSR visto (ver idcloudServer)
  batidas         INT DEFAULT 0,
  total_coletado  INT DEFAULT 0,
  coletas         INT DEFAULT 0,
  conectado_em    DATETIME,
  ultima_coleta   DATETIME,
  ultimo_erro     VARCHAR(255),
  atualizado_em   DATETIME,
  UNIQUE KEY uq_rep (id_reps),
  KEY idx_atualizado (atualizado_em)
);

-- ---------------------------------------------------------------------------
-- iDFace: coletor de ponto (push oficial). O iDFace NAO e' REP-P: ele so
-- entrega marcacoes. O iZCloud guarda o dispositivo, a fila de comandos, os
-- resultados, as marcacoes e o vinculo device_user_id <-> pessoa.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idface_dispositivos (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  token CHAR(48) NOT NULL,              -- token no path do push (/api/idface/<token>/push)
  device_id BIGINT,                     -- deviceId estavel enviado no poll
  serial VARCHAR(32),
  idcloud_code VARCHAR(32),
  nome VARCHAR(100),
  id_Equipamento BIGINT,                -- vinculo opcional com equipamentos (mesma empresa)
  portaria CHAR(4) DEFAULT '671',       -- '595' (PIS/1510-like) ou '671' (CPF)
  ativo BIT DEFAULT 1,
  ultimo_contato DATETIME,
  ultimo_uuid VARCHAR(64),
  criado_em DATETIME,
  UNIQUE KEY uq_token (token),
  KEY idx_device (device_id),
  KEY idx_equip (id_Equipamento)
);

CREATE TABLE IF NOT EXISTS idface_comandos (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_dispositivo BIGINT NOT NULL,
  verb VARCHAR(10) DEFAULT 'POST',
  endpoint VARCHAR(100) NOT NULL,
  body TEXT,                            -- JSON do corpo do comando
  query_string VARCHAR(100),            -- ex.: mode=671 (NAO usar ? no endpoint)
  content_type VARCHAR(60) DEFAULT 'application/json',
  status ENUM('pendente','entregue','concluido','erro') DEFAULT 'pendente',
  criado_em DATETIME,
  entregue_em DATETIME,
  concluido_em DATETIME,
  erro VARCHAR(255),
  KEY idx_fila (id_dispositivo, status, id)
);

CREATE TABLE IF NOT EXISTS idface_resultados (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_dispositivo BIGINT,
  endpoint VARCHAR(100),
  uuid VARCHAR(64),
  response LONGTEXT,
  erro VARCHAR(255),
  criado_em DATETIME,
  KEY idx_disp (id_dispositivo, id)
);

-- Marcacoes do iDFace. `device_user_id` e' o users.id do equipamento; o
-- documento (PIS/CPF) so existe se o equipamento tiver sido provisionado assim.
-- Guardamos os dois para nao depender de o id ser estavel (o RHiD troca).
CREATE TABLE IF NOT EXISTS idface_marcacoes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_dispositivo BIGINT NOT NULL,
  device_user_id BIGINT,
  documento VARCHAR(20),
  nsr INT,
  data_hora DATETIME,                   -- horario local do equipamento
  data_hora_utc DATETIME,               -- mesmo instante em UTC
  fuso VARCHAR(8),                      -- ex.: -0400
  tipo_registro CHAR(1),                -- '3' ou '7'
  origem VARCHAR(20),                   -- export_afd | access_logs | push
  linha TEXT,
  sha256 CHAR(64),
  criado_em DATETIME,
  UNIQUE KEY uq_marc (id_dispositivo, origem, nsr, data_hora),
  KEY idx_data (data_hora),
  KEY idx_doc (documento)
);

-- Ultimo snapshot de users/c_users do equipamento (para o operador mapear).
CREATE TABLE IF NOT EXISTS idface_usuarios (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_dispositivo BIGINT NOT NULL,
  device_user_id BIGINT NOT NULL,
  registration VARCHAR(32),
  nome VARCHAR(120),
  cpf VARCHAR(20),
  atualizado_em DATETIME,
  UNIQUE KEY uq_user (id_dispositivo, device_user_id)
);

-- Vinculo versionado: nunca sobrescrever. Se o equipamento trocar o users.id,
-- fecha o vinculo antigo (valid_to) e abre um novo; as marcacoes antigas
-- continuam apontando para o vinculo antigo.
CREATE TABLE IF NOT EXISTS idface_vinculos (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_dispositivo BIGINT NOT NULL,
  device_user_id BIGINT NOT NULL,
  id_pessoa INT,
  documento VARCHAR(20),
  valid_from DATETIME NOT NULL,
  valid_to DATETIME,
  origem VARCHAR(32),
  UNIQUE KEY uq_vigente (id_dispositivo, device_user_id, valid_from),
  KEY idx_pessoa (id_pessoa)
);

-- ---------------------------------------------------------------------------
-- Arquivos AFD brutos (iDClass e iDFace), do jeito que o equipamento gerou.
-- E' a fonte para o cliente baixar o AFD completo / por NSR / por data sem
-- depender de recalcular CRC/header. O path fica em data/afd/<schema>/.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS afd_arquivos (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  origem VARCHAR(20) NOT NULL,          -- idclass | idface | import
  formato VARCHAR(8),                   -- 595 | 671
  serial VARCHAR(32),
  id_Equipamento BIGINT,
  id_dispositivo BIGINT,
  nome VARCHAR(200),
  caminho VARCHAR(500),
  sha256 CHAR(64),
  tamanho INT,
  nsr_inicial INT,
  nsr_final INT,
  data_inicio DATETIME,
  data_fim DATETIME,
  criado_em DATETIME,
  KEY idx_equip (id_Equipamento, criado_em),
  KEY idx_disp (id_dispositivo, criado_em)
);