// Procura no firmware e no AFD Downloader as strings que revelam o canal
// de comunicacao: host, URL, porta, caminho de API.
import fs from 'fs';
import path from 'path';

const ALVOS = [
  'fw.bin',
  'dump-write.bin',
  path.join('AFD Downloader', 'Controlid.iDCloud.DataCloud.dll'),
];

const INTERESSE = /(idsecure|ids?\.|push|cloud|\.com|\.br|http|api\/|mysql|3306|amazonaws|rds\.|iDCloud|server|host|port)/i;

for (const rel of ALVOS) {
  const p = path.join('C:\\Producao\\Gerenciador REPs', rel);
  if (!fs.existsSync(p)) { console.log(`\n=== ${rel}: NAO EXISTE`); continue; }
  const buf = fs.readFileSync(p);
  // ASCII
  const ascii = buf.toString('latin1');
  // UTF-16LE (comum em .NET)
  const utf16 = buf.toString('utf16le');

  const achar = (txt, rot) => {
    const out = new Set();
    for (const m of txt.matchAll(/[\x20-\x7e]{6,}/g)) {
      const s = m[0];
      if (INTERESSE.test(s)) out.add(s);
    }
    return [...out];
  };

  const a = achar(ascii);
  const u = achar(utf16);
  console.log(`\n=== ${rel}  (${buf.length} bytes)`);
  console.log(`  ASCII  relevante: ${a.length}`);
  a.slice(0, 60).forEach((s) => console.log('    A  ' + s.slice(0, 120)));
  console.log(`  UTF16  relevante: ${u.length}`);
  u.slice(0, 60).forEach((s) => console.log('    U  ' + s.slice(0, 120)));
}
