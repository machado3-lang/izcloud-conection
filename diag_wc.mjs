import fs from 'fs';
const p = 'C:\\Producao\\Gerenciador REPs\\AFD Downloader\\WC.dll';
const buf = fs.readFileSync(p);
for (const [rot, txt] of [['A', buf.toString('latin1')], ['U', buf.toString('utf16le')]]) {
  const s = new Set();
  for (const m of txt.matchAll(/[\x20-\x7e]{4,}/g)) {
    const v = m[0];
    if (/idsecure|https|\/api|host|url|endpoint|token|certificat|thumbprint|subject|issuer|serial/i.test(v)) s.add(v);
  }
  console.log(`\n=== WC.dll ${rot}: ${s.size}`);
  [...s].sort().forEach(x => console.log('  ' + x.slice(0, 150)));
}
