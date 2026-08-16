-- schema_tenant.sql — Tabelas de UM cliente (executado dentro do schema tenant_XXXX)
-- Sem CREATE DATABASE / USE: o core cria o schema e roda este script dentro dele.
-- Espelha o modelo iDCloud (ControlID), confinado ao tenant.

-- Equipamentos (REPs).Lectura/escrita pela nuvem.
CREATE TABLE IF NOT EXISTS equipamentos (
  id_Equipamento INT PRIMARY KEY,
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

-- Para tenants ja criados (sem a coluna), rode:
-- ALTER TABLE equipamentos ADD COLUMN ModoConexao ENUM('nuvem_puxa','rep_empurra') DEFAULT 'nuvem_puxa';

-- Pessoas. PIS e CPF coexistem (confirmado no AFD Downloader).
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
  INDEX idx_cpf (CPF)
);

-- Vinculo pessoa x equipamento
CREATE TABLE IF NOT EXISTS equip_pessoa (
  id_Pessoa INT,
  id_Equipamento INT,
  PRIMARY KEY (id_Pessoa, id_Equipamento)
);

-- AFD (somente leitura pela nuvem; o REP escreve). Dado = linha crua.
-- UNIQUE (id_Equipamento, NSR) garante idempotencia do ON DUPLICATE KEY UPDATE
-- (sem isso, sincronizacoes repetidas duplicariam marcações).
CREATE TABLE IF NOT EXISTS afd (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_Equipamento INT NOT NULL,
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
  id_Equipamento INT,
  documento VARCHAR(20),    -- PIS ou CPF conforme o REP
  tipo_registro CHAR(1),
  data DATETIME,
  dado TEXT,
  nsr INT,
  crc CHAR(4)
);

-- Controle de sincronizacao incremental por equipamento (NSR)
CREATE TABLE IF NOT EXISTS sync_status (
  id_Equipamento INT PRIMARY KEY,
  last_nsr INT DEFAULT 0,
  last_sync DATETIME,
  ativo BOOLEAN DEFAULT 1
);

-- Templates biometricos (digitais e faces) por pessoa.
-- dados = template em base64 (formato do REP). um por (id_pessoa, tipo, indice).
CREATE TABLE IF NOT EXISTS templates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_pessoa INT NOT NULL,
  tipo VARCHAR(20),        -- 'digital' | 'face'
  indice INT,              -- dedo (1..10) ou slot de face
  dados LONGTEXT,
  DataAtualizacao DATETIME,
  UNIQUE KEY uq_tpl (id_pessoa, tipo, indice),
  KEY idx_pessoa (id_pessoa)
);

-- Para tenants ja criados (sem a tabela), rode:
-- CREATE TABLE templates ( id BIGINT AUTO_INCREMENT PRIMARY KEY, id_pessoa INT NOT NULL,
--   tipo VARCHAR(20), indice INT, dados LONGTEXT, DataAtualizacao DATETIME,
--   UNIQUE KEY uq_tpl (id_pessoa, tipo, indice), KEY idx_pessoa (id_pessoa) );
