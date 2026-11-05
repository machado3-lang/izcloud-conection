// importarRep.js — le empresa/empregador, funcionarios e biometria da memoria
// do REP e grava no schema do tenant.
//
// Fluxo de produto: o cliente liga um REP que ja tem empresa e funcionarios
// cadastrados. Em vez de redigitar tudo, o iZCloud le do proprio aparelho
// (`load_company` + `load_users?templates=true`) e cria/atualiza o tenant,
// vinculando os funcionarios ao REP.
//
// As funcoes de leitura sao passadas por parametro (`deps`) para o teste rodar
// sem REP e sem MySQL.
import { lerUsuarios as lerUsuariosReal, lerEmpresa as lerEmpresaReal, mapearUsuario } from './repClient.js';

// O numero curto (ex.: PIS 1, 123) e' o codigo de iDCloud do aparelho, nao um
// funcionario. PIS/CPF reais tem 11 digitos.
export function documentoValido(pis, cpf) {
  const doc = String(pis || cpf || '').replace(/\D/g, '');
  return doc.length > 6;
}

export async function importarDoRep({
  client,
  idEquipamento,
  ip,
  porta = 443,
  usuario = 'admin',
  senha = 'admin',
  empresa,
  usuarios,
  deps = {},
}) {
  const lerEmpresa = deps.lerEmpresa || lerEmpresaReal;
  const lerUsuarios = deps.lerUsuarios || lerUsuariosReal;

  const dadosEmpresa = empresa !== undefined ? empresa : await lerEmpresa(ip, porta, usuario, senha);
  const lista = usuarios !== undefined ? usuarios : await lerUsuarios(ip, porta, usuario, senha);

  let empregador = null;
  if (dadosEmpresa) {
    empregador = await client.importarEmpresa({ idEquipamento, empresa: dadosEmpresa });
  }

  let pessoas = 0, templates = 0, ignorados = 0;
  for (const u of lista) {
    const m = mapearUsuario(u);
    if (!documentoValido(m.pis, m.cpf)) { ignorados++; continue; }
    const idP = await client.importarPessoa({ ...m, portaria: m.tipo });
    await client.vincularEquipamento(idP, idEquipamento);
    for (const t of m.templates) {
      await client.gravarTemplate(idP, t.tipo, t.indice, t.dados);
      templates++;
    }
    pessoas++;
  }

  return {
    empresa: empregador,
    pessoas,
    templates,
    usuarios: lista.length,
    ignorados,
  };
}
