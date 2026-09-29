import fs from 'fs';
const p = 'C:\\Producao\\Gerenciador REPs\\AFD Downloader\\Controlid.iDCloud.DataCloud.dll';
const a = fs.readFileSync(p).toString('latin1');
const u = fs.readFileSync(p).toString('utf16le');
for (const [rot, txt] of [['ASCII', a], ['UTF16', u]]) {
  const s = new Set();
  for (const m of txt.matchAll(/[\x20-\x7e]{5,}/g)) {
    const v = m[0];
    if (/idsecure|\.com|\.br|http|api|mysql|3306|amazonaws|rds|cloud|host|port|endpoint|url|token|login|senha|pass/i.test(v)) s.add(v);
  }
  console.log(`\n=== ${rot}: ${s.size} strings relevantes`);
  [...s].sort().forEach(x => console.log('  ' + x.slice(0, 150)));
}
