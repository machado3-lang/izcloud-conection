// afd.js — Parser e geracao de AFD (portado/adaptado do PontoEngine.js do Pontoweb)
// Suporta Portaria 1510 (PIS) e 671 (CPF). O AFD baixado do iDCloud ja vem no
// layout correto em `Dado`; aqui tratamos tanto o parse quanto a geracao por periodo.

export function detectarTipo(linha) {
  if (!linha || linha.length < 10) return null;
  // 671 (ISO) tem '-' na posicao 14 (apos NSR(9)+tipo(1))
  if (linha.length > 14 && linha[14] === '-') return '671';
  return '1510';
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
      documento = linha.substring(34, 45); // CPF
    } else {
      const d = linha.substring(10, 12);
      const m = linha.substring(12, 14);
      const y = linha.substring(14, 18);
      const hh = linha.substring(18, 20);
      const mm = linha.substring(20, 22);
      dataHora = new Date(y, parseInt(m, 10) - 1, d, hh, mm);
      documento = linha.substring(22, 34); // PIS (12)
      if (documento.length === 12 && documento.startsWith('0')) documento = documento.substring(1);
    }
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

// Gera AFD (header + registros + trailer) a partir de linhas cruas ja no layout,
// filtrado por periodo. `linhasCruas` = array de strings (linhas '3').
export function gerarPorPeriodo({ linhasCruas, serial, dataInicio, dataFim, formato }) {
  const inicio = dataInicio ? new Date(dataInicio) : null;
  const fim = dataFim ? new Date(dataFim) : null;
  const fmt = formato || '1510';

  const filtradas = linhasCruas.filter((l) => {
    const r = parseLinhaBatida(l);
    if (!r || !r.dataHora) return false;
    if (inicio && r.dataHora < inicio) return false;
    if (fim && r.dataHora > fim) return false;
    return true;
  });

  const now = new Date();
  const dataStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const horaStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const numSerie = (serial || '').padEnd(17, ' ').slice(0, 17);

  const lines = [];
  if (fmt === '671') {
    lines.push(`0000000011000000000${dataStr}${horaStr}${numSerie}${' '.repeat(228)}`);
  } else {
    lines.push(`0000000011${dataStr.slice(0, 2)}${dataStr.slice(2, 4)}${dataStr.slice(4, 8)}${horaStr.slice(0, 4)}${numSerie}${' '.repeat(182)}`);
  }

  let nsr = 1;
  for (const l of filtradas) {
    // Preserva a linha crua original (ja no layout do REP) e renumera o NSR no header local
    lines.push(l.trim());
    nsr++;
  }

  const total = String(filtradas.length).padStart(9, '0');
  if (fmt === '671') lines.push(`${total}9${' '.repeat(250)}`);
  else lines.push(`${total}9${' '.repeat(42)}`);

  return { texto: lines.join('\r\n'), total: filtradas.length };
}
