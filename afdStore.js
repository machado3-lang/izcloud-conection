// afdStore.js — guarda o AFD bruto (iDClass e iDFace) em disco + metadados no
// banco do tenant.
//
// Por que guardar o arquivo bruto: o AFD tem CRC/header/trailer calculados pelo
// equipamento. Regerar a partir das linhas tipo 3 exige reproduzir o CRC e o
// leiaute exato de cada firmware. Guardar o arquivo que o equipamento gerou
// resolve os dois casos (iDClass e iDFace) e ainda vira auditoria.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AFD_DIR = process.env.IZCLOUD_AFD_DIR || path.join(__dirname, 'data', 'afd');

function dirDoTenant(schema) {
  const dir = path.join(AFD_DIR, String(schema || 'sem_schema'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function nomeSeguro(v) {
  return String(v || 'sem-serial').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

// Salva o texto do AFD e registra em `afd_arquivos`. `pool` e' o pool do tenant
// (database = schema), entao o INSERT nao precisa prefixar o schema.
export async function salvarArquivoAfd(pool, {
  schema,
  origem = 'idclass',
  formato = '1510',
  serial = null,
  idEquipamento = null,
  idDispositivo = null,
  texto = '',
  nome = null,
  nsrInicial = null,
  nsrFinal = null,
  dataInicio = null,
  dataFim = null,
} = {}) {
  const conteudo = String(texto || '');
  const dir = dirDoTenant(schema);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = nome
    ? nomeSeguro(nome)
    : `${nomeSeguro(origem)}_${nomeSeguro(formato)}_${nomeSeguro(serial || idEquipamento || idDispositivo)}_${ts}`;
  const arquivo = path.join(dir, `${base}.txt`);
  // AFD e' ISO-8859-1 (Portaria). Gravar em latin1 preserva os bytes originais;
  // gravar em utf8 mudaria acentos do campo razao social.
  fs.writeFileSync(arquivo, conteudo, 'latin1');

  const sha256 = crypto.createHash('sha256').update(conteudo, 'latin1').digest('hex');
  const tamanho = Buffer.byteLength(conteudo, 'latin1');

  const [res] = await pool.query(
    `INSERT INTO afd_arquivos
      (origem, formato, serial, id_Equipamento, id_dispositivo, nome, caminho,
       sha256, tamanho, nsr_inicial, nsr_final, data_inicio, data_fim, criado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    [origem, formato, serial, idEquipamento, idDispositivo, base, arquivo,
      sha256, tamanho, nsrInicial, nsrFinal, dataInicio, dataFim]
  );

  return {
    id: res.insertId,
    nome: base,
    caminho: arquivo,
    sha256,
    tamanho,
    formato,
    origem,
  };
}

export async function listarArquivos(pool, { origem, idEquipamento, idDispositivo, limite = 100 } = {}) {
  let sql = 'SELECT id, origem, formato, serial, id_Equipamento, id_dispositivo, nome, sha256, tamanho, nsr_inicial, nsr_final, data_inicio, data_fim, criado_em FROM afd_arquivos WHERE 1=1';
  const params = [];
  if (origem) { sql += ' AND origem = ?'; params.push(origem); }
  if (idEquipamento) { sql += ' AND id_Equipamento = ?'; params.push(idEquipamento); }
  if (idDispositivo) { sql += ' AND id_dispositivo = ?'; params.push(idDispositivo); }
  sql += ' ORDER BY criado_em DESC, id DESC LIMIT ?';
  params.push(Math.min(Number(limite) || 100, 500));
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function lerArquivoAfd(pool, id) {
  const [rows] = await pool.query('SELECT * FROM afd_arquivos WHERE id = ?', [Number(id)]);
  if (!rows.length) return null;
  const row = rows[0];
  if (!row.caminho || !fs.existsSync(row.caminho)) {
    return { ...row, conteudo: null, erro: 'arquivo nao encontrado no disco' };
  }
  return { ...row, conteudo: fs.readFileSync(row.caminho, 'latin1') };
}
