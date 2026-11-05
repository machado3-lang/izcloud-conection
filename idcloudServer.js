// idcloudServer.js - o lado do servidor do canal iDCloud.
//
// COMO FUNCIONA (medido no REP, ver docs/PROTOCOLOS.md secao 12):
//   1. o REP abre uma conexao TLS na 443 contra o IP configurado em txtIPCloud
//   2. o REP NAO envia nada: ele espera o servidor falar
//   3. o servidor manda  POST /<comando>.fcgi  com JSON e o REP responde JSON
//   4. a sessao sai de  POST /login.fcgi  nessa mesma conexao
//   5. get_afd.fcgi devolve o AFD como application/octet-stream
//
// Ou seja: e' a API FCGI de sempre (repClient.js), so que invertida - aqui o
// servidor e' o cliente HTTP do FCGI.
//
// POR QUE A TRAVA DE SERIE E' OBRIGATORIA
// O REP nao se apresenta: ele abre o socket e fica mudo. Logo nao ha como ele
// provar quem e, e um login.fcgi com admin/admin funciona por qualquer um que
// chegue na porta. A mitigacao e' verificar o nSerie logo na primeira mensagem e
// derrubar a conexao se nao for o REP esperado daquele vagao. A sessao nunca sai
// da conexao que a originou.
import tls from 'tls';
import { parseAFD, detectarTipo } from './afd.js';
import { salvarArquivoAfd } from './afdStore.js';
import { IdCloudClient } from './idcloud.js';
import { getTenantPool, registrarConexaoRep, registrarColetaRep, estadoColetaRep, buscarRepPorSerial } from './core.js';
import { importarDoRep } from './importarRep.js';

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

// Uma "vaga": qual REP esta autorizado a usar a proxima conexao. A vaga precisa
// carregar o SCHEMA do tenant e o SERIAL: a conexao chega so com o nSerie, e sem
// isso a coleta nao sabe em qual banco gravar (antes ela usava o serial como se
// fosse o nome do schema).
const vagas = new Map();   // id_reps -> { id_reps, schema, serial, passcode, ate }

export function reservarVaga(id_reps, minutos = 30, { schema = null, serial = null, passcode = null } = {}) {
  const ate = Date.now() + minutos * 60 * 1000;
  vagas.set(String(id_reps), {
    id_reps: Number(id_reps) || 0,
    schema: schema || null,
    serial: serial ? String(serial) : null,
    passcode: passcode || null,
    ate,
  });
  // O proprio REP pode reconectar varias vezes; a vaga vale para a janela toda.
  if (vagas.size > 200) for (const [k, v] of vagas) if (v.ate < Date.now()) vagas.delete(k);
  return ate;
}

// Usado pelos testes e por um restart controlado.
export function limparVagas() { vagas.clear(); }

// Vaga exata (serial) tem prioridade; uma vaga sem serial serve para qualquer
// aparelho. `agora` existe para testar expiracao sem esperar.
export function vagaPara(nSerie, agora = Date.now()) {
  const alvo = String(nSerie || '');
  let generica = null;
  for (const [id, v] of vagas) {
    if (v.ate <= agora) { vagas.delete(id); continue; }
    if (v.serial) {
      if (v.serial === alvo) return v;
    } else if (!generica) {
      generica = v;
    }
  }
  return generica;
}

// Resolve a vaga de uma conexao. Se nao houver reserva manual, aceita
// automaticamente o REP cujo serial ja esta cadastrado em alguma empresa ativa.
// `IDCLOUD_AUTOACEITE=false` volta ao modelo antigo (so reserva manual).
async function resolverVaga(nSerie) {
  const vaga = vagaPara(nSerie);
  if (vaga && vaga.schema) return vaga;

  const auto = /^(1|true|sim)$/i.test(String(process.env.IDCLOUD_AUTOACEITE ?? 'true'));
  if (!auto) return vaga;

  let achado = null;
  try { achado = await buscarRepPorSerial(nSerie); }
  catch (e) { log(`busca do serial ${nSerie} falhou: ${e.message}`); }
  if (!achado) return vaga;

  // Uma vaga generica (sem schema) pode ser completada pelo serial cadastrado.
  if (vaga) return Object.assign(vaga, achado, { ate: vaga.ate });
  log(`REP ${nSerie} reconhecido automaticamente em ${achado.schema}`);
  return { ...achado, ate: Date.now() + 60 * 1000 };
}

// Cliente FCGI que fala com um REP por uma conexao TLS ja aberta.
class SessaoRep {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    // Slot unico de pendencia. Os comandos sao sempre sequenciais (um por vez,
    // aguardando a resposta), entao um mapa com id nao traria ganho nenhum --
    // so uma chance a mais de bug de ordenacao.
    this.pendente = null;
    this.primeira = true;
    this.session = null;
    this.nSerie = null;
    socket.on('data', (d) => this._chegou(d));
    socket.on('close', () => this._falhou('REP fechou a conexao'));
    socket.on('error', (e) => this._falhou(e.message));
  }

  _falhou(motivo) {
    if (this.pendente) { this.pendente.rej(new Error(motivo)); this.pendente = null; }
  }

  _chegou(d) {
    this.buffer = Buffer.concat([this.buffer, d]);
    while (this.buffer.length) {
      // O REP mistura \n e \r\n nos headers (medido na captura), entao aceito os
      // dois terminadores. Sem isso a resposta nunca "fecha" e tudo da timeout.
      let fim = this.buffer.indexOf('\r\n\r\n');
      let salto = 4;
      if (fim < 0) { fim = this.buffer.indexOf('\n\n'); salto = 2; }
      if (fim < 0) break;
      const cab = this.buffer.subarray(0, fim).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(cab);
      const total = Number(m ? m[1] : 0);
      if (this.buffer.length < fim + salto + total) break;
      const corpo = this.buffer.subarray(fim + salto, fim + salto + total).toString('utf-8');
      this.buffer = this.buffer.subarray(fim + salto + total);
      const status = Number((/HTTP\/1\.\d\s+(\d+)/.exec(cab) || [])[1] || 0);
      const p = this.pendente;
      if (!p) continue;                       // resposta sem pedido: descarta
      this.pendente = null;
      clearTimeout(p.timer);
      let dados = null, binario = null;
      try { dados = JSON.parse(corpo); } catch { binario = corpo; }
      if (status >= 400) { p.rej(new Error((dados && dados.error) || `HTTP ${status}`)); continue; }
      p.res({ dados, binario, status });
    }
  }

  pedir(comando, corpo = {}, { binario = false } = {}) {
    if (this.socket.destroyed) return Promise.reject(new Error('conexao fechada'));
    if (this.pendente) return Promise.reject(new Error('comando anterior ainda em andamento'));
    const base = String(comando).split('?')[0];
    if (!COMANDOS.has(base)) return Promise.reject(new Error(`comando nao permitido: ${base}`));
    const b = Buffer.from(JSON.stringify(corpo), 'utf-8');
    const req = Buffer.from(
      `POST /${comando}.fcgi HTTP/1.1\r\nHost: idcloud\r\nUser-Agent: iZCloud/1.0\r\n` +
      `Accept: */*\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${b.length}\r\nConnection: keep-alive\r\n\r\n`, 'latin1');
    return new Promise((res, rej) => {
      // get_afd pode devolver o arquivo inteiro (dezenas de milhares de linhas);
      // load_users com templates tambem pode passar de centenas de KB.
      const ms = base === 'get_afd' ? 120000 : (base === 'load_users' ? 60000 : 30000);
      const timer = setTimeout(() => { this.pendente = null; rej(new Error(`${comando}: timeout`)); }, ms);
      timer.unref?.();
      this.pendente = { res, rej, timer };
      // O REP precisa de um instante depois do handshake antes de aceitar o
      // primeiro comando: mandando na hora ele ignora e a resposta nunca vem.
      const escrever = () => {
        if (this.pendente?.timer !== timer) return;   // ja expirou/cancelou
        try { this.socket.write(Buffer.concat([req, b])); }
        catch (e) { this.pendente = null; clearTimeout(timer); rej(e); }
      };
      if (this.primeira) { this.primeira = false; setTimeout(escrever, 500); }
      else escrever();
    });
  }
}

export async function atenderConexao(socket) {
  const rep = new SessaoRep(socket);
  try {
    // 1) Neste firmware (v1048) `get_about` EXIGE sessao: sem `session` ele
    // responde 401. O canal antigo chamava get_about antes do login e por isso
    // nunca identificava o REP. O login tem de vir primeiro.
    //
    // Limitacao de protocolo: o REP nao se apresenta; a senha do web server e'
    // enviada antes de sabermos o serial. Use uma senha forte (REP_ADMIN_SENHA)
    // e restrinja ao maximo quem alcanca a 443.
    const senhaAdmin = process.env.REP_ADMIN_SENHA || 'admin';
    const login = await rep.pedir('login', { login: 'admin', password: senhaAdmin });
    rep.session = login.dados?.session || null;
    if (!rep.session) throw new Error('login sem session');

    // 2) agora sim: qual REP e' esse?
    const about = await rep.pedir('get_about', { session: rep.session });
    const nSerie = String(about.dados?.nSerie || '');
    rep.nSerie = nSerie;
    if (!nSerie) throw new Error('REP nao devolveu nSerie');

    const vaga = await resolverVaga(nSerie);
    if (!vaga) {
      log(`conexao de ${nSerie} RECUSADA: REP nao cadastrado e nenhuma vaga reservada`);
      socket.end();
      return null;
    }
    log(`REP ${nSerie} conectado (id_reps=${vaga.id_reps} schema=${vaga.schema || '-'})`);

    // 3) estado do aparelho
    const info = await rep.pedir('get_system_information', { session: rep.session });
    log(`REP ${nSerie}: ${info.dados?.user_count} usuarios, NSR ${info.dados?.last_nsr}`);

    return { rep, id_reps: vaga.id_reps, schema: vaga.schema, sobre: about.dados, info: info.dados };
  } catch (e) {
    log(`conexao recusada: ${e.message}`);
    socket.end();
    return null;
  }
}

// Baixa o AFD do REP, sem tocar no banco. Separado da gravacao de proposito:
// da para exercitar o canal inteiro numa maquina sem MySQL.
//
// Teto que o REP aceita em `limit`. Acima disso ele responde
// "'limit' máximo é 1000" — medido no aparelho.
export const LIMITE_AFD_MAX = 1000;

// O QUE MUDOU AQUI (04/11/2026):
// A documentacao concluiu que o REP "nao pagina" e que so daria para ver as
// primeiras 1000 linhas. Mas o README §9 registra 38.523 linhas baixadas pelo
// `repClient.baixarAfd`, que NAO envia `limit`. A hipotese mais forte e' que
// omitir o campo devolve o arquivo inteiro; o canal estava se limitando sozinho.
//
// Padrao: NAO envia `limit` (arquivo inteiro). `IDCLOUD_AFD_LIMIT` permite
// voltar ao comportamento antigo (ex.: 1000) sem alterar codigo.
function limiteAfdPadrao() {
  const n = Number(process.env.IDCLOUD_AFD_LIMIT ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(n, LIMITE_AFD_MAX) : 0;
}

export async function baixarAfd(ctx, { limite = undefined, offset = 0 } = {}) {
  const lim = limite === undefined
    ? limiteAfdPadrao()
    : Math.min(Math.max(Number(limite) || 0, 0), LIMITE_AFD_MAX);
  const corpo = { session: ctx.rep.session, offset };
  if (lim > 0) corpo.limit = lim;
  const r = await ctx.rep.pedir('get_afd', corpo, { binario: true });
  const texto = (r.binario || '').trim();
  if (!texto) return { texto: '', batidas: 0, linhas: 0, ultimoNsr: null, paginas: 0, truncado: false };
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
  const { registros } = parseAFD(texto);
  return {
    texto,
    linhas: linhas.length,
    batidas: registros.length,
    ultimoNsr: registros.at(-1)?.nsr ?? null,
    paginas: 1,
    // So da para afirmar que truncou quando NOS limitamos a janela.
    truncado: lim > 0 && linhas.length >= lim,
    limite: lim || null,
  };
}

// Baixa o AFD e grava no tenant. Devolve quantas batidas entraram.
export async function sincronizarAfd(ctx, opcoes = {}) {
  const { texto, batidas, ultimoNsr } = await baixarAfd(ctx, opcoes);
  if (!texto) return { batidas: 0, motivo: 'AFD vazio' };
  const client = new IdCloudClient(getTenantPool(ctx.schema));
  const novas = await client.salvarAfd(ctx.rep.nSerie, texto.split(/\r?\n/));
  log(`AFD de ${ctx.rep.nSerie}: ${batidas} batidas, ${novas} gravadas`);
  return { batidas, novas, ultimoNsr };
}

// Le os funcionarios do REP. O mapeamento para o schema do tenant fica a
// cargo de quem chamar: aqui devolvemos o cru, sem inventar campo.
export async function lerFuncionarios(ctx, { limite = 100, offset = 0, templates = false } = {}) {
  const corpo = { session: ctx.rep.session, limit: limite, offset };
  if (templates) corpo.templates = true;
  const r = await ctx.rep.pedir('load_users', corpo);
  return r.dados?.users || [];
}

export async function lerEmpresa(ctx) {
  const r = await ctx.rep.pedir('load_company', { session: ctx.rep.session });
  return r.dados?.company || null;
}

// Coleta completa de uma conexao: baixa o AFD a partir do cursor, grava no
// tenant e atualiza o estado. E' o que roda quando o REP conecta.
export async function coletar(ctx, { limite = undefined } = {}) {
  const schema = ctx.schema;
  if (!schema) throw new Error('coleta sem schema de tenant (vaga incompleta)');
  await registrarConexaoRep(schema, { id_reps: ctx.id_reps, serial: ctx.rep.nSerie });
  try {
    const client = new IdCloudClient(getTenantPool(schema));

    // Primeiro contato: se o tenant ainda nao tem funcionarios, le a empresa e
    // os funcionarios que JA ESTAO na memoria do REP. Isso evita redigitar o
    // cadastro de um REP que chega pronto. Nao sobrescreve um tenant ja
    // povoado; para reimportar use POST /api/reps/:id/importar.
    const autoImport = /^(1|true|sim)$/i.test(String(process.env.IDCLOUD_IMPORTAR_AUTOMATICO ?? 'true'));
    if (autoImport) {
      const [p] = await client.pool.query('SELECT COUNT(*) AS n FROM pessoas');
      if (!Number(p[0]?.n || 0)) {
        try {
          const empresa = await lerEmpresa(ctx);
          const usuarios = [];
          for (let offset = 0, i = 0; i < 100; i++) {
            const pagina = await lerFuncionarios(ctx, { limite: 100, offset, templates: true });
            if (!pagina.length) break;
            usuarios.push(...pagina);
            offset += pagina.length;
            if (pagina.length < 100) break;
          }
          const imp = await importarDoRep({ client, idEquipamento: ctx.id_reps, empresa, usuarios });
          log(`importacao inicial de ${ctx.rep.nSerie}: ${imp.pessoas} funcionarios, ` +
              `${imp.templates} templates, ${imp.ignorados} ignorados`);
        } catch (e) {
          log(`importacao inicial falhou (a coleta continua): ${e.message}`);
        }
      }
    }

    const est = await estadoColetaRep(schema, ctx.id_reps);
    const anterior = Number(est?.ultimo_nsr || 0);
    const { texto, batidas, ultimoNsr, truncado } = await baixarAfd(ctx, { limite, offset: 0 });
    if (!texto) {
      await registrarColetaRep(schema, { id_reps: ctx.id_reps, batidas: 0, novas: 0 });
      return { batidas: 0, novas: 0, vazio: true };
    }
    // Idempotente por NSR. O `desdeNsr` evita reprocessar o arquivo inteiro:
    // no primeiro contato ele e' 0 (tudo entra); nas proximas, so o que avancou.
    // O UNIQUE(id_Equipamento, NSR) continua sendo a rede de seguranca.
    const novas = await client.salvarAfd(ctx.rep.nSerie, texto.split(/\r?\n/), { desdeNsr: anterior });

    // Guarda o AFD bruto (header + tipo 3 + trailer) para o cliente baixar
    // depois. Nao pode derrubar a coleta: se o disco falhar, as batidas ja
    // estao no banco.
    try {
      const linhasAfd = texto.split(/\r?\n/).filter((l) => l.trim());
      const primeira = linhasAfd.find((l) => l[9] === '3');
      const formato = primeira ? detectarTipo(primeira) : '1510';
      const nsrs = linhasAfd.filter((l) => l[9] === '3')
        .map((l) => parseInt(l.substring(0, 9), 10)).filter(Number.isFinite);
      await salvarArquivoAfd(getTenantPool(schema), {
        schema,
        origem: 'idclass',
        formato: formato === '671' ? '671' : '595',
        serial: ctx.rep.nSerie,
        idEquipamento: ctx.id_reps,
        texto,
        nsrInicial: nsrs.length ? Math.min(...nsrs) : null,
        nsrFinal: nsrs.length ? Math.max(...nsrs) : null,
      });
    } catch (e) {
      log(`aviso: AFD bruto de ${ctx.rep.nSerie} nao foi salvo: ${e.message}`);
    }

    const avancou = !ultimoNsr || !anterior || Number(ultimoNsr) > anterior;
    await registrarColetaRep(schema, { id_reps: ctx.id_reps, ultimoNsr, batidas, novas });
    log(`coleta de ${ctx.rep.nSerie}: ${batidas} batidas na janela, ${novas} novas` +
        (truncado ? ' (janela limitada: confira o historico completo)' : ''));
    return { batidas, novas, ultimoNsr, avancou, truncado };
  } catch (e) {
    await registrarColetaRep(schema, { id_reps: ctx.id_reps, erro: e.message });
    throw e;
  }
}

// `aoConectar` recebe o contexto autenticado e decide o que fazer com a
// conexao (baixar AFD, ler usuarios, ...). O socket fecha quando o callback
// termina - a sessao FCGI vale so enquanto a conexao estiver viva.
export function criarServidor({ cert, key, porta = 443, host, aoConectar = coletar }) {
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
