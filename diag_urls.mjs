// Filtro Cirurgico: so o que parece dominio, URL, caminho de API ou nome de
// produto. A varredura ampla anterior foi enterrada em strings do mbedTLS.
import fs from 'fs';
import path from 'path';

const ALVOS = [
  'fw.bin',
  path.join('AFD Downloader', 'Controlid.iDCloud.DataCloud.dll'),
];

const PADROES = [
  ['URL http(s)', /https?:\/\/[\w\-\.\/:%?=&]{4,}/gi],
  ['dominio .com/.br/.net', /\b[\w\-]{2,40}\.(?:com|com\.br|net|net\.br|org|io|amazonaws\.com)\b/gi],
  ['idsecure/idcloud', /[\w\-\.]*id(?:secure|cloud)[\w\-\.]*/gi],
  ['caminho /api', /\/api[\w\-\/\.]{0,40}/gi],
  ['REST/iDClass', /\[\s*REST\s*\][^\x00]{0,60}/gi],
  ['Content-Type', /Content-Type[^\x00]{0,40}/gi],
  ['mysql', /\b(?:mysql|libmysql|COM_QUERY|COM_QUIT)\b/gi],
  ['porta 3306 como texto', /\b3306\b/gi],
  ['User-Agent', /User-Agent[^\x00]{0,80}/gi],
  ['POST/GET', /\b(?:POST|GET|PUT)\s+\/[a-z]{0,20}/gi],
];

for (const rel of ALVOS) {
  const p = path.join('C:\\Producao\\Gerenciador REPs', rel);
  const buf = fs.readFileSync(p);
  const ascii = buf.toString('latin1');
  console.log(`\n================ ${rel} (${buf.length} bytes)`);
  for (const [rot, re] of PADROES) {
    const hits = new Set();
    for (const m of ascii.matchAll(re)) hits.add(m[0].trim());
    if (hits.size) {
      console.log(`\n  [${rot}] ${hits.size} ocorrencia(s)`);
      [...hits].slice(0, 25).forEach((s) => console.log('     ' + s.slice(0, 110)));
    }
  }

  // contexto em volta de palavras-chave, para nao perder o vizinho
  for (const chave of ['idsecure', 'idcloud', 'IDCLOUD', 'iDCloud', 'push.', '/api', 'Looking for']) {
    const hits = [];
    let i = ascii.indexOf(chave);
    while (i >= 0 && hits.length < 6) {
      hits.push(i);
      i = ascii.indexOf(chave, i + 1);
    }
    if (hits.length) {
      console.log(`\n  >>> contexto de "${chave}" (${hits.length} pontos):`);
      for (const h of hits) {
        const ini = Math.max(0, h - 48);
        const ctx = ascii.slice(ini, h + chave.length + 64).replace(/[^\x20-\x7e]/g, '.');
        console.log(`     @${h}  ...${ctx}...`);
      }
    }
  }
}
