// afd.js — Parser e geracao de AFD (portado/adaptado do PontoEngine.js do Pontoweb)
// Suporta Portaria 1510 (PIS) e 671 (CPF). O AFD baixado do iDCloud ja vem no
// layout correto em `Dado`; aqui tratamos tanto o parse quanto a geracao por periodo.

export function detectarTipo(linha) {
  if (!linha || linha.length < 10) return null;
  // 671 (ISO) tem '-' na posicao 14 (apos NSR(9)+tipo(1))
  if (linha.length > 14 && linha[14] === '-') return '671';
  return '1510';
}

// Extrai o documento (PIS/CPF) de uma linha tipo 3.
//
// Medido no iDFace 6.26.4 (05/11/2026): no layout 671 o campo do documento vem
// com 12 digitos (um zero a esquerda) antes do CRC, e nao 11 como no layout
// padrao. Ler substring(34,45) cortava o ultimo digito. Aqui pegamos tudo o que
// existe antes do CRC (4 chars) e removemos o zero de preenchimento.
export function extrairDocumento(linha) {
  const l = (linha || '').trim();
  if (l.length <= 9 || l[9] !== '3') return '';
  const tipo = detectarTipo(l);
  let doc;
  if (tipo === '671') {
    const resto = l.substring(34);
    const campo = resto.length >= 4 ? resto.slice(0, -4) : resto;
    doc = campo.replace(/\D/g, '');
  } else {
    doc = l.substring(22, 34).replace(/\D/g, '');
  }
  if (doc.length === 12 && doc.startsWith('0')) doc = doc.slice(1);
  return doc;
}

// Extrai os campos de uma linha de batida (tipo '3')
export function parseLinhaBatida(linha) {
  linha = (linha || '').trim();
  if (linha.length <= 9) return null;
  if (linha[9] !== '3') return null; // so batidas

  const nsr = linha.substring(0, 9);
  const tipo = detectarTipo(linha);
  let documento = '';
  let dataHora = null;

  try {
    if (tipo === '671') {
      const dataHoraStr = linha.substring(10, 29); // YYYY-MM-DDTHH:MM:SS
      dataHora = new Date(dataHoraStr);
    } else {
      const d = linha.substring(10, 12);
      const m = linha.substring(12, 14);
      const y = linha.substring(14, 18);
      const hh = linha.substring(18, 20);
      const mm = linha.substring(20, 22);
      dataHora = new Date(y, parseInt(m, 10) - 1, d, hh, mm);
    }
    documento = extrairDocumento(linha);
  } catch {
    return null;
  }

  return { nsr, tipo, documento, dataHora, linha };
}

// Parse de um conteudo AFD completo -> metadados + linhas cruas
export function parseAFD(conteudo) {
  const linhas = conteudo.split(/\r?\n/);
  const registros = [];
  const porDocumento = {};

  for (const l of linhas) {
    const t = l[9];
    if (t === '3') {
      const r = parseLinhaBatida(l);
      if (r) {
        registros.push(r);
        (porDocumento[r.documento] ||= []).push(r);
      }
    }
  }
  return { registros, porDocumento, total: registros.length };
}

// Gera AFD 1510 (header + registros + trailer) a partir de linhas cruas ja no
// layout, filtrado por periodo. `linhasCruas` = array de strings (linhas '3').
//
// Para 671 NAO geramos: o header/trailer do 671 tem CRC do fabricante e o
// caminho correto e' baixar o arquivo bruto do REP (GET /api/afd/download).
// Regerar sem o CRC produziria um arquivo fiscal invalido em silencio.
export function gerarPorPeriodo({ linhasCruas, serial, dataInicio, dataFim, formato, empregador }) {
  const fmt = formato === '671' ? '671' : '1510';
  if (fmt === '671') {
    throw new Error('AFD 671 deve ser baixado bruto do REP (GET /api/afd/download): ' +
      'o header/trailer tem CRC do fabricante e nao pode ser regerado aqui.');
  }

  const dataSoDia = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const inicio = dataInicio
    ? (dataSoDia(dataInicio)
      ? new Date(`${dataInicio}T00:00:00`)
      : new Date(dataInicio))
    : null;
  const fim = dataFim
    ? (dataSoDia(dataFim)
      ? new Date(`${dataFim}T23:59:59.999`)
      : new Date(dataFim))
    : null;

  const filtradas = linhasCruas.filter((l) => {
    const r = parseLinhaBatida(l);
    if (!r || !r.dataHora) return false;
    if (inicio && r.dataHora < inicio) return false;
    if (fim && r.dataHora > fim) return false;
    return true;
  });

  const now = new Date();
  const dois = (n) => String(n).padStart(2, '0');
  const ddmmaaaa = (v) => {
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) return null;
      return `${dois(v.getDate())}${dois(v.getMonth() + 1)}${v.getFullYear()}`;
    }
    const s = String(v || '');
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[3]}${iso[2]}${iso[1]}`;
    if (/^(19|20)\d{6}$/.test(s)) return `${s.slice(6, 8)}${s.slice(4, 6)}${s.slice(0, 4)}`;
    if (/^\d{8}$/.test(s)) return s;
    return null;
  };

  const emp = empregador || {};
  const doc = String(emp.CNPJ_CPF || emp.cnpj || '').replace(/\D/g, '');
  const tpIdt = doc.length === 11 ? '2' : '1';
  const idt = (doc || '0').padStart(14, '0').slice(-14);
  const cei = String(emp.CEI || emp.cei || '').replace(/\D/g, '').padStart(12, '0').slice(-12);
  const razao = String(emp.RazaoSocial || emp.razao_social || '').padEnd(150, ' ').slice(0, 150);
  const numSerie = String(serial || '').padStart(17, '0').slice(-17);

  const primeira = parseLinhaBatida(filtradas[0]);
  const ultima = parseLinhaBatida(filtradas[filtradas.length - 1]);
  const ini = ddmmaaaa(dataInicio) || ddmmaaaa(primeira?.dataHora) || ddmmaaaa(now);
  const fimArq = ddmmaaaa(dataFim) || ddmmaaaa(ultima?.dataHora) || ddmmaaaa(now);
  const ger = ddmmaaaa(now);
  const hora = `${dois(now.getHours())}${dois(now.getMinutes())}`;

  // Layout 1510 (Anexo I): 9+1+1+14+12+150+17+8+8+8+4 = 232 chars.
  const lines = [
    `0000000001${tpIdt}${idt}${cei}${razao}${numSerie}${ini}${fimArq}${ger}${hora}`,
  ];
  for (const l of filtradas) lines.push(l.trim());

  // Trailer 1510: 999999999 + tipo2 + tipo3 + tipo4 + tipo5 + 9 = 46 chars.
  const total = String(filtradas.length).padStart(9, '0');
  lines.push(`999999999000000000${total}0000000000000000009`);

  return { texto: lines.join('\r\n'), total: filtradas.length };
}
