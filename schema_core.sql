-- schema_core.sql — Banco "core" do iZCloud
-- Dois niveis:
--   contas  = login do CLIENTE do iZCloud (quem compra o sistema). Uma conta
--             pode ter VARIAS empresas (filiais). Cada conta so enxerga as suas.
--   clientes = EMPRESA (tenant). Pertence a uma conta (id_conta) e tem o perfil
--             completo (razao social, CNPJ, endereco, responsavel). Continua sendo
--             o "numero do banco" (schema_name) e a credencial de API externa.

CREATE DATABASE IF NOT EXISTS izcloud_core;
USE izcloud_core;

-- Conta do cliente do iZCloud (login web). Isolada: so enxerga suas empresas.
CREATE TABLE IF NOT EXISTS contas (
  id_conta   INT AUTO_INCREMENT PRIMARY KEY,
  login      VARCHAR(64) NOT NULL UNIQUE,
  senha_hash VARCHAR(255) NOT NULL,          -- "salt:hash" (scrypt)
  nome       VARCHAR(120),
  ativo      BIT DEFAULT 1,
  criado_em  DATETIME
);

-- Empresas (tenants). schema_name == "numero do banco" do iDCloud.
CREATE TABLE IF NOT EXISTS clientes (
  id_cliente        INT AUTO_INCREMENT PRIMARY KEY,
  id_conta          INT,                       -- dono (contas.id_conta)
  login             VARCHAR(64) UNIQUE,        -- credencial de API externa (Secullum)
  senha_hash        VARCHAR(255),              -- "salt:hash" (scrypt) — API externa
  schema_name       VARCHAR(64) NOT NULL,      -- ex.: tenant_0007
  razao_social      VARCHAR(160),
  nome_empresa      VARCHAR(120),
  cnpj              VARCHAR(20),
  endereco          VARCHAR(200),
  responsavel_nome  VARCHAR(120),
  responsavel_cpf   VARCHAR(20),
  ativo             BIT DEFAULT 1,
  criado_em         DATETIME
);

-- Usuarios/operadores de UMA empresa (multi-usuario por empresa).
-- A conta da empresa (contas) e o admin; aqui ficam os operadores adicionais.
CREATE TABLE IF NOT EXISTS usuarios (
  id_usuario  INT AUTO_INCREMENT PRIMARY KEY,
  id_cliente  INT NOT NULL,
  schema_name VARCHAR(64) NOT NULL,
  login       VARCHAR(64) NOT NULL,
  senha_hash  VARCHAR(255) NOT NULL,
  nome        VARCHAR(120),
  nivel       ENUM('admin','operador') DEFAULT 'operador',
  ativo       BIT DEFAULT 1,
  criado_em   DATETIME,
  UNIQUE KEY uq_usuario_login (login),
  KEY idx_cliente (id_cliente)
);

-- MIGRACOES p/ core ja existente (rode no MySQL da nuvem):
-- CREATE TABLE contas ( id_conta INT AUTO_INCREMENT PRIMARY KEY, login VARCHAR(64) NOT NULL UNIQUE,
--   senha_hash VARCHAR(255) NOT NULL, nome VARCHAR(120), ativo BIT DEFAULT 1, criado_em DATETIME );
-- ALTER TABLE clientes
--   ADD COLUMN id_conta INT,
--   ADD COLUMN razao_social VARCHAR(160),
--   ADD COLUMN endereco VARCHAR(200),
--   ADD COLUMN responsavel_nome VARCHAR(120),
--   ADD COLUMN responsavel_cpf VARCHAR(20);
-- (Opcional) vincular empresas ja existentes a uma conta recém-criada:
--   INSERT INTO contas (login, senha_hash, nome) VALUES ('admin', '<hash>', 'Migracao');
--   UPDATE clientes SET id_conta = (SELECT id_conta FROM contas WHERE login='admin') WHERE id_conta IS NULL;
