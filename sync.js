// sync.js — Sincronizacao incremental de AFD por NSR (modelo "empurrar para a nuvem")
import { proxyREP } from './repClient.js';
import { IdCloudClient } from './idcloud.js';

// Busca do REP apenas a partir de last_nsr+1 e insere no schema do cliente (tenant).
// Se o firmware ignorar initial_nsr, filtramos client-side (so NSR > last_nsr).
export async function sincronizarAfd({ ip, porta, usuario, senha, idEquipamento, mode, client }) {
  const [st] = await client.pool.query('SELECT last_nsr FROM sync_status WHERE id_Equipamento = ?', [idEquipamento]);
  const lastNsr = st?.length ? (st[0].last_nsr || 0) : 0;

  const sess = (await proxyREP(ip, porta, 'login', { login: usuario, password: senha })).session;
  const body = { session: sess, initial_nsr: lastNsr + 1 };

  let txt;
  try {
    if (mode === '671') {
      const r = await proxyREP(ip, porta, 'get_afd?mode=671', body);
      txt = r?.afd || r?.raw;
    }
  } catch { /* 1510 nao suporta mode=671 */ }
  if (!txt) {
    const r = await proxyREP(ip, porta, 'get_afd', body);
    txt = r?.afd || r?.raw;
  }

  const linhas = String(txt || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let maxNsr = lastNsr;
  let inseridos = 0;

  for (const l of linhas) {
    if (l[9] !== '3') continue;
    const nsr = parseInt(l.substring(0, 9), 10);
    if (!(nsr > lastNsr)) continue; // incremental: so o que veio depois

    const is671 = l.length > 14 && l[14] === '-';
    let doc = '', data = null;
    try {
      if (is671) { doc = l.substring(34, 45); data = new Date(l.substring(10, 29)); }
      else {
        const d = l.substring(10, 12), m = l.substring(12, 14), y = l.substring(14, 18);
        const hh = l.substring(18, 20), mm = l.substring(20, 22);
        doc = l.substring(22, 34);
        data = new Date(y, parseInt(m, 10) - 1, d, hh, mm);
      }
    } catch {}

    await client.pool.query(
      `INSERT INTO afd (id_Equipamento, PIS, NSR, Data, Tipo, Dado, CRC)
       VALUES (?, ?, ?, ?, 3, ?, NULL)
       ON DUPLICATE KEY UPDATE Dado = VALUES(Dado)`,
      [idEquipamento, doc || null, nsr, data, l]
    );
    inseridos++;
    if (nsr > maxNsr) maxNsr = nsr;
  }

  await client.pool.query(
    `INSERT INTO sync_status (id_Equipamento, last_nsr, last_sync, ativo)
     VALUES (?, ?, NOW(), 1)
     ON DUPLICATE KEY UPDATE last_nsr = ?, last_sync = NOW()`,
    [idEquipamento, maxNsr, maxNsr]
  );

  return { inseridos, lastNsr: maxNsr };
}

// Poller silencioso: itera TODOS os tenants ativos e sincroniza seus REPs.
export function iniciarPoller(getCore, getTenant, intervalMs = 60000) {
  const timer = setInterval(async () => {
    let core;
    try { core = getCore(); } catch { return; }
    try {
      const [clientes] = await core.query('SELECT id_cliente, schema_name FROM clientes WHERE ativo = 1');
      for (const c of clientes) {
        const tp = getTenant(c.schema_name);
        const client = new IdCloudClient(tp);
        try {
          const [reps] = await tp.query(
            "SELECT id_Equipamento, IpAddress, Porta, Passcode, REPType FROM equipamentos WHERE IpAddress IS NOT NULL"
          );
          for (const r of reps) {
            try {
              await sincronizarAfd({
                ip: r.IpAddress,
                porta: r.Porta || 443,
                usuario: 'admin', senha: r.Passcode || 'admin',
                idEquipamento: r.id_Equipamento,
                mode: r.REPType === '671' ? '671' : '1510',
                client,
              });
            } catch (e) {
              console.error(`[poller] ${c.schema_name} sync ${r.id_Equipamento}:`, e.message);
            }
          }
        } catch (e) {
          console.error(`[poller] ${c.schema_name}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[poller]', e.message);
    }
  }, intervalMs);
  return timer;
}
