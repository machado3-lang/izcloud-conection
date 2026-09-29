import fs from 'fs';
const p = 'C:\\Producao\\Gerenciador REPs\\AFD Downloader\\Controlid.iDCloud.DataCloud.dll';
const buf = fs.readFileSync(p);
const u = buf.toString('utf16le');
const a = buf.toString('latin1');
const linhas = [];
for (const [rot, txt] of [['U16', u], ['ASC', a]]) {
  for (const m of txt.matchAll(/[\x20-\x7e]{4,}/g)) linhas.push(rot + '|' + m.index + '|' + m[0]);
}
fs.writeFileSync('dll_strings.txt', linhas.join('\n'), 'latin1');
console.log('strings extraidas: ' + linhas.length);
