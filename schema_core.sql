-- schema_core.sql — Banco "core" do iZCloud (contas de clientes / tenants)
-- Um unico banco central; cada cliente aponta para o seu proprio schema (tenant).
CREATE DATABASE IF NOT EXISTS izcloud_core;
USE izcloud_core;

-- Contas de clientes (tenants). schema_name == "numero do banco" do iDCloud.
CREATE TABLE IF NOT EXISTS clientes (
  id_cliente   INT AUTO_INCREMENT PRIMARY KEY,
  login        VARCHAR(64) NOT NULL UNIQUE,
  senha_hash   VARCHAR(255) NOT NULL,          -- formato "salt:hash" (scrypt)
  schema_name  VARCHAR(64) NOT NULL,          -- ex.: tenant_0007
  nome_empresa VARCHAR(120),
  cnpj         VARCHAR(20),
  ativo        BIT DEFAULT 1,
  criado_em    DATETIME
);

-- Usuarios/operadores de UM tenant (multi-usuario por empresa).
-- A conta da empresa (tabela `clientes`) e o admin; aqui ficam os operadores
-- adicionais. login e UNICO globalmente (resolve o tenant no login web).
-- Sistemas externos (Basic + X-Client-DB) continuam usando SO a conta da empresa.
CREATE TABLE IF NOT EXISTS usuarios (
  id_usuario  INT AUTO_INCREMENT PRIMARY KEY,
  id_cliente  INT NOT NULL,
  schema_name VARCHAR(64) NOT NULL,           -- denormalizado p/ lookup rapido
  login       VARCHAR(64) NOT NULL,
  senha_hash  VARCHAR(255) NOT NULL,          -- "salt:hash" (scrypt)
  nome        VARCHAR(120),
  nivel       ENUM('admin','operador') DEFAULT 'operador',
  ativo       BIT DEFAULT 1,
  criado_em   DATETIME,
  UNIQUE KEY uq_usuario_login (login),
  KEY idx_cliente (id_cliente)
);

-- Para core ja existente (sem a tabela), rode:
-- CREATE TABLE usuarios ( id_usuario INT AUTO_INCREMENT PRIMARY KEY,
--   id_cliente INT NOT NULL, schema_name VARCHAR(64) NOT NULL, login VARCHAR(64) NOT NULL,
--   senha_hash VARCHAR(255) NOT NULL, nome VARCHAR(120), nivel ENUM('admin','operador') DEFAULT 'operador',
--   ativo BIT DEFAULT 1, criado_em DATETIME, UNIQUE KEY uq_usuario_login (login), KEY idx_cliente (id_cliente) );
