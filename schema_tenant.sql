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
  id_reps         INT NOT NULL,
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