import fs from 'fs';
const p = 'C:\\Producao\\Gerenciador REPs\\AFD Downloader\\Controlid.iDCloud.DataCloud.dll';
const buf = fs.readFileSync(p);
const a = buf.toString('latin1');
const u = buf.toString('utf16le');

// 1) strings UTF-16 (literais do C# ficam em UTF-16 no .NET)
console.log('=== literais UTF-16 (C#) ===');
const s16 = new Set();
for (const m of u.matchAll(/[\x20-\x7e]{4,}/g)) s16.add(m[0]);
[...s16].sort().forEach(x => console.log('  ' + x.slice(0, 160)));
