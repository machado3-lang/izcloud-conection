-- schema.sql — Banco do iZCloud (nosso, modelo iDCloud)
-- O REP (1510/671) sincroniza aqui; a API web do iZCloud lê/escreve aqui.

CREATE DATABASE IF NOT EXISTS izcloud;
USE izcloud;

-- Equipamentos (REPs). Lectura/escrita pela nuvem.
CREATE TABLE IF NOT EXISTS equipamentos (
  id_Equipamento INT PRIMARY KEY,
  id_Empregador INT,
  Nome CHAR(50),
  utc_Equipamento INT,
  AplicaHorarioVerao BIT,
  statusPapel CHAR(50),
  qtdePessoas INT,
  qtdeDigitais INT,
  -- campos da nossa nuvem:
  IpAddress VARCHAR(50),
  Porta INT,
  Passcode VARCHAR(100),
  REPType CHAR(4),            -- '1510' ou '671' (auto-detectado ou manual)
  DataAtualizacao DATETIME
);

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
CREATE TABLE IF NOT EXISTS afd (
  id_Equipamento INT,
  PIS BIGINT,
  NSR INT,
  Data DATETIME,
  Tipo INT,
  Dado VARCHAR(300),
  CRC CHAR(4),
  INDEX idx_equip (id_Equipamento),
  INDEX idx_data (Data)
);

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

