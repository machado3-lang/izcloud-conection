import fs from 'fs';
import path from 'path';
const RAIZ = 'C:\\Producao\\Gerenciador REPs';
const TERMOS = [/idsecure/gi, /mysqld?/gi, /mariadb/gi, /\b5\.[567]\.\d+/gi, /\b8\.0\.\d+/gi, /cloud1\./gi, /amazonaws/gi, /\/api\//gi];
function*v(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(bin|obj|node_modules|\.git)$/i.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* g(p);
    else if (/\.(dll|exe|bin|config|json|xml|txt|ini|cfg|py|pdb)$/i.test(e.name)) yield p;
  }
}
var g = function* (d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (/^(bin|obj|\.git)$/i.test(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) yield* g(p); else if (/\.(dll|exe|bin|config|json|xml|txt|ini|cfg|py)$/i.test(e.name)) yield p; } };
const vistos = new Map();
for (const p of g(RAIZ)) {
  let buf; try { buf = fs.readFileSync(p); } catch { continue; }
  if (buf.length > 80 * 1024 * 1024) continue;
  const hits = [];
  for (const [rot, txt] of [['A', buf.toString('latin1')], ['U', buf.toString('utf16le')]]) {
    for (const re of TERMOS) { re.lastIndex = 0; for (const m of txt.matchAll(re)) hits.push(rot + ' ' + m[0]); }
  }
  if (hits.length) {
    const uniq = [...new Set(hits)].slice(0, 8);
    console.log(`\n${p.replace(RAIZ + '\\', '')}  [${buf.length} B]`);
    console.log('   ' + uniq.join('  |  '));
  }
}
