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
