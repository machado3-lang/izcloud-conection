// sync.js — Sincronizacao incremental de AFD por NSR (modelo "empurrar para a nuvem")
import { proxyREP } from './repClient.js';
import { IdCloudClient } from './idcloud.js';

// Busca do REP apenas a partir de last_nsr+1 e insere no schema do cliente (tenant).
// Se o firmware ignorar initial_nsr, filtramos client-side (so NSR > last_nsr).
export async function sincronizarAfd({ ip, porta, usuario, senha, idEquipamento, mode, client }) {
  const [st] = await client.pool.query('SELECT last_nsr FROM sync_status WHERE id_Equipamento = ?', [idEquipamento]);
  const lastNsr = st?.length ? (st[0].last_nsr || 0) : 0;

  const r = await coletarAfdRep({
    ip, porta, usuario, senha, idEquipamento, mode, client,
    initialNsr: lastNsr + 1,
    desdeNsr: lastNsr,
    atualizarCursor: true,
  });
  return { inseridos: r.inseridos, lastNsr: r.maxNsr };
}

// Coleta o AFD do REP com filtro explicito:
//   completo  -> arquivo inteiro (sem initial_nsr/initial_date)
//   initialNsr -> a partir do NSR informado (inclusive)
//   initialDate -> a partir da data { day, month, year }
//
// `atualizarCursor` so deve ser true na coleta incremental. Um download manual
// por data/NSR nao pode mover o cursor do poller para tras nem para frente.
export async function coletarAfdRep({
  ip, porta, usuario, senha, idEquipamento, mode, client,
  completo = false, initialNsr = null, initialDate = null,
  desdeNsr = 0, atualizarCursor = false,
} = {}) {
  const sess = (await proxyREP(ip, porta, 'login', { login: usuario, password: senha })).session;
  const body = { session: sess };
  if (!completo) {
    if (initialNsr != null && Number.isFinite(Number(initialNsr))) {
      body.initial_nsr = Number(initialNsr);
    }
    if (initialDate && Number(initialDate.day) && Number(initialDate.month) && Number(initialDate.year)) {
      body.initial_date = {
        day: Number(initialDate.day),
        month: Number(initialDate.month),
        year: Number(initialDate.year),
      };
    }
  }

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
  let maxNsr = Number(desdeNsr) || 0;
  for (const l of linhas) {
    if (l[9] !== '3' && l[9] !== '7') continue;
    const nsr = parseInt(l.substring(0, 9), 10);
    if (Number.isFinite(nsr) && nsr > maxNsr) maxNsr = nsr;
  }

  // Gravacao em lote (500 por INSERT) e filtro client-side: este firmware
  // ignora `initial_nsr` e devolve o arquivo inteiro (~38 mil linhas). Gravar
  // linha a linha fazia a sincronizacao completa demorar minutos.
  const inseridos = await client.salvarAfd(idEquipamento, linhas, {
    desdeNsr: Number(desdeNsr) || 0,
  });

  if (atualizarCursor) {
    await client.pool.query(
      `INSERT INTO sync_status (id_Equipamento, last_nsr, last_sync, ativo)
       VALUES (?, ?, NOW(), 1)
       ON DUPLICATE KEY UPDATE last_nsr = ?, last_sync = NOW()`,
      [idEquipamento, maxNsr, maxNsr]
    );
  }

  return { texto: String(txt || ''), linhas, inseridos, maxNsr };
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
            "SELECT id_Equipamento, IpAddress, Porta, Passcode, REPType FROM equipamentos " +
            "WHERE IpAddress IS NOT NULL AND (ModoConexao IS NULL OR ModoConexao = 'nuvem_puxa')"
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
