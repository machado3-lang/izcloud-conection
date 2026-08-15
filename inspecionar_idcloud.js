// inspecionar_idcloud.js
// INSPEÇÃO SOMENTE DE ESQUEMA (não lê dados de clientes).
// Use onde o seu MySQL do iDCloud é alcançável.
//
// Uso:
//   npm i mysql2
//   node inspecionar_idcloud.js
//
// Configure as variáveis de ambiente (NUNCA commite credenciais):
//   IDCLOUD_HOST=seu-host-rds.amazonaws.com
//   IDCLOUD_PORT=3306
//   IDCLOUD_USER=seu_usuario
//   IDCLOUD_PASS=sua_senha
//   IDCLOUD_DB=nome_do_banco

import mysql from 'mysql2/promise';

const cfg = {
  host: process.env.IDCLOUD_HOST,
  port: Number(process.env.IDCLOUD_PORT || 3306),
  user: process.env.IDCLOUD_USER,
  password: process.env.IDCLOUD_PASS,
  database: process.env.IDCLOUD_DB,
  ssl: { rejectUnauthorized: false },
};

const TABELAS = [
  'pessoas', 'afd', 'equipamentos', 'equip_pessoa',
  'templates', 'departamentos', 'departamentos_equip', 'empregadores',
];

async function main() {
  if (!cfg.host || !cfg.user || !cfg.database) {
    console.error('Defina IDCLOUD_HOST, IDCLOUD_USER, IDCLOUD_PASS e IDCLOUD_DB');
    process.exit(1);
  }
  const conn = await mysql.createConnection(cfg);
  console.log(`\n=== BANCO: ${cfg.database} @ ${cfg.host} ===`);

  // Lista todas as tabelas (para não perder nenhuma não documentada)
  const [tables] = await conn.query('SHOW TABLES');
  const todas = tables.map(t => Object.values(t)[0]);
  console.log('\nTABELAS EXISTENTES:', todas.join(', '));

  for (const t of TABELAS) {
    if (!todas.includes(t)) continue;
    const [cols] = await conn.query(`DESCRIBE \`${t}\``);
    console.log(`\n--- ${t} ---`);
    for (const c of cols) {
      console.log(`  ${c.Field.padEnd(22)} ${c.Type.padEnd(14)} ${c.Null === 'NO' ? 'NOT NULL' : 'null    '} ${c.Key || ''}`);
    }
  }

  // Amostra de 1 linha do afd, SÓ as colunas (sem dados sensíveis)
  if (todas.includes('afd')) {
    const [cols] = await conn.query('DESCRIBE `afd`');
    console.log('\n--- afd: colunas (sem dados) ---');
    console.log('  ' + cols.map(c => c.Field).join(', '));
  }

  await conn.end();
  console.log('\nInspeção de esquema concluída (nenhum dado de cliente foi lido).');
}

main().catch(e => {
  console.error('Falha ao conectar/inspecionar:', e.message);
  process.exit(1);
});
