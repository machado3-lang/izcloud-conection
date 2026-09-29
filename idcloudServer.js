// idcloudServer.js — o lado do servidor do canal iDCloud.
//
// COMO FUNCIONA (medido no REP, ver docs/PROTOCOLOS.md secao 12):
//   1. o REP abre uma conexao TLS na 443 contra o IP configurado em txtIPCloud
//   2. o REP NAO envia nada: ele espera o servidor falar
//   3. o servidor manda  POST /<comando>.fcgi  com JSON e o REP responde JSON
//   4. a sessao sai de  POST /login.fcgi  nessa mesma conexao
//   5. get_afd.fcgi devolve o AFD como application/octet-stream
//
// Ou seja: e' a API FCGI de sempre (repClient.js), so que invertida — aqui o
// servidor e' o cliente HTTP do FCGI.
//
// POR QUE A TRAVA DE SERIE E' OBRIGATORIA
// O REP nao se apresenta: ele abre o socket e fica mudo. Logo nao ha como ele
// provar quem e, e um login.fcgi com admin/admin funciona por qualquer um que
// chegue na porta. A mitigacao e' verificar o nSerie logo na primeira mensagem e
// derrubar a conexao se nao for o REP esperado daquele vagao. A sessao nunca sai
// da conexao que a originou.
import tls from 'tls';
import { parseAFD } from './afd.js';
import { IdCloudClient } from './idcloud.js';
import { getTenantPool } from './core.js';

const log = (...a) => console.log('[idcloud]', ...a);

// Comandos FCGI que o firmware aceita (lista extraida do binario).
export const COMANDOS = new Set([
  'login', 'logout', 'change_login',
  'get_about', 'get_info', 'get_public_key', 'get_afd',
  'get_configuration', 'set_configuration', 'get_idcloud', 'set_idcloud',
  'get_system_configuration', 'get_system_date_time', 'set_system_date_time',
  'get_system_daylight_saving_time', 'set_system_daylight_saving_time',
  'get_system_network', 'set_system_network', 'get_system_information',
  'set_coil_paper', 'get_coil_paper', 'set_identification_type', 'set_ticket_size',
  'set_animation_screen', 'set_buzzer_beep',
  'load_users', 'update_users', 'remove_users', 'remove_admins', 'remove_templates',
  'load_company',
]);

// Um "vagao": qual REP esta autorizado a usar a proxima conexao. Populado por
// quem programa o atendimento (a UI chama reservedEsperaDeRep).
const vagas = new Map();   // id_reps -> timestamp

export function reservarVaga(id_reps, minutos = 30) {
  const ate = Date.now() + minutos * 60 * 1000;
  vagas.set(String(id_reps), ate);
  // O proprio REP pode reconectar varias vezes; a vaga vale para a janela toda.
  if (vagas.size > 200) for (const [k, t] of vagas) if (t < Date.now()) vagas.delete(k);
  return ate;
}

function vagaPara(nSerie) {
  let livre = null;
  for (const [id, ate] of vagas) {
    if (ate > Date.now()) { livre = { id, ate }; break; }
    vagas.delete(id);
  }
  return livre;
}

// Cliente FCGI que fala com um REP por uma conexao TLS ja aberta.
class SessaoRep {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.espera = new Map();
    this.seq = 0;
    this.session = null;
    this.nSerie = null;
    socket.on('data', (d) => this._chegou(d));
    socket.on('close', () => this._falhou('REP fechou a conexao'));
    socket.on('error', (e) => this._falhou(e.message));
  }

  _falhou(motivo) {
    for (const [, p] of this.espera) p.rej(new Error(motivo));
    this.espera.clear();
  }

  _chegou(d) {
    this.buffer = Buffer.concat([this.buffer, d]);
    while (this.buffer.length) {
      const fim = this.buffer.indexOf('\r\n\r\n');
      if (fim < 0) break;
      const cab = this.buffer.subarray(0, fim).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(cab);
      const total = Number(m ? m[1] : 0);
      if (this.buffer.length < fim + 4 + total) break;
      const corpo = this.buffer.subarray(fim + 4, fim + 4 + total).toString('utf-8');
      this.buffer = this.buffer.subarray(fim + 4 + total);
      const status = Number((/HTTP\/1\.\d\s+(\d+)/.exec(cab) || [])[1] || 0);
      const id = Number((/^X-Seq:\s*(\d+)/i.exec(cab) || [])[1] || 0);
      const p = this.espera.get(id);
      if (!p) continue;
      this.espera.delete(id);
      let dados = null, binario = null, erro = null;
      try { dados = JSON.parse(corpo); } catch { binario = corpo; }
      if (status >= 400) erro = new Error((dados && dados.error) || `HTTP ${status}`);
      else if (dados && dados.error) erro = new Error(dados.error);
      p.res({ dados, binario, status });
    }
  }

  pedir(comando, corpo = {}, { binario = false } = {}) {
    if (this.socket.destroyed) return Promise.reject(new Error('conexao fechada'));
    const id = ++this.seq;
    const b = Buffer.from(JSON.stringify(corpo), 'utf-8');
    const req = Buffer.from(
      `POST /${comando}.fcgi HTTP/1.1\r\nHost: idcloud\r\nUser-Agent: iZCloud/1.0\r\n` +
      `Accept: */*\r\nContent-Type: application/json\r\nX-Seq: ${id}\r\n` +
      `Content-Length: ${b.length}\r\nConnection: keep-alive\r\n\r\n`, 'latin1');
    return new Promise((res, rej) => {
      this.espera.set(id, { res, rej });
      this.socket.write(Buffer.concat([req, b]));
      setTimeout(() => {
        if (this.espera.has(id)) { this.espera.delete(id); rej(new Error(`${comando}: timeout`)); }
      }, 30000).unref?.();
    });
  }
}

export async function atenderConexao(socket) {
  const rep = new SessaoRep(socket);
  try {
    // 1) primeira coisa: qual REP e' esse? Sem isso qualquer um entra.
    const about = await rep.pedir('get_about', {});
    const nSerie = String(about.dados?.nSerie || '');
    rep.nSerie = nSerie;
    if (!nSerie) throw new Error('REP nao devolveu nSerie');

    const vaga = vagaPara(nSerie);
    if (!vaga) {
      log(`conexao de ${nSerie} RECUSADA: nenhum REP reservado`);
      socket.end();
      return null;
    }
    log(`REP ${nSerie} conectado (id_reps=${vaga.id})`);

    // 2) sessao FCGI na MESMA conexao
    const login = await rep.pedir('login', { login: 'admin', password: process.env.REP_ADMIN_SENHA || 'admin' });
    rep.session = login.dados?.session || null;
    if (!rep.session) throw new Error('login sem session');

    const info = await rep.pedir('get_system_information', { session: rep.session });
    log(`REP ${nSerie}: ${info.dados?.user_count} usuarios, NSR ${info.dados?.last_nsr}`);

    return { rep, id_reps: vaga.id, schema: nSerie, sobre: about.dados, info: info.dados };
  } catch (e) {
    log(`conexao recusada: ${e.message}`);
    socket.end();
    return null;
  }
}

// Baixa o AFD do REP, sem tocar no banco. Separado da gravacao de proposito:
// dá para exercitar o canal inteiro numa maquina sem MySQL.
export async function baixarAfd(ctx, { limite = 2000, offset = 0 } = {}) {
  const r = await ctx.rep.pedir('get_afd', { session: ctx.rep.session, limit: limite, offset }, { binario: true });
  const texto = (r.binario || '').trim();
  if (!texto) return { texto: '', batidas: 0 };
  const { registros } = parseAFD(texto);
  return { texto, batidas: registros.length, ultimoNsr: registros.at(-1)?.nsr ?? null };
}

// Baixa o AFD e grava no tenant. Devolve quantas batidas entraram.
export async function sincronizarAfd(ctx, opcoes = {}) {
  const { texto, batidas, ultimoNsr } = await baixarAfd(ctx, opcoes);
  if (!texto) return { batidas: 0, motivo: 'AFD vazio' };
  const client = new IdCloudClient(getTenantPool(ctx.schema));
  const novas = await client.salvarAfd(BigInt(0), texto.split(/\r?\n/));
  log(`AFD de ${ctx.rep.nSerie}: ${batidas} batidas, ${novas} gravadas`);
  return { batidas, novas, ultimoNsr };
}

// Le os funcionarios do REP. O mapeamento para o schema do tenant fica a
// cargo de quem chamar: aqui devolvemos o cru, sem inventar campo.
export async function lerFuncionarios(ctx, { limite = 500, offset = 0 } = {}) {
  const r = await ctx.rep.pedir('load_users', { session: ctx.rep.session, limit: limite, offset });
  return r.dados?.users || [];
}

export async function lerEmpresa(ctx) {
  const r = await ctx.rep.pedir('load_company', { session: ctx.rep.session });
  return r.dados?.company || null;
}

// `aoConectar` recebe o contexto autenticado e decide o que fazer com a
// conexao (baixar AFD, ler usuarios, ...). O socket fecha quando o callback
// termina — a sessao FCGI vale so enquanto a conexao estiver viva.
export function criarServidor({ cert, key, porta = 443, host, aoConectar }) {
  const servidor = tls.createServer({ cert, key, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }, (s) => {
    s.setTimeout(120000, () => s.destroy());
    atenderConexao(s)
      .then(async (ctx) => {
        if (!ctx) return;
        if (aoConectar) await aoConectar(ctx);
      })
      .catch((e) => log('atendimento falhou:', e.message))
      .finally(() => s.end());
  });
  servidor.on('tlsClientError', (e) => log('TLS:', e.message));
  servidor.on('error', (e) => log('erro no servidor:', e.message));
  return new Promise((res, rej) => {
    servidor.once('error', rej);
    servidor.listen(porta, host, () => { log(`ouvindo ${host}:${porta}`); res(servidor); });
  });
}
