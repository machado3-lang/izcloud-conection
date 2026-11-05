// Testes da importacao REP -> nuvem, com o formato REAL medido no REP
// (192.168.100.132, firmware 1048): templates como strings base64, paginacao
// com count e o usuario de numero curto que nao e funcionario.
//
//   npm test
import assert from 'node:assert/strict';
import { mapearUsuario } from '../repClient.js';
import { importarDoRep, documentoValido } from '../importarRep.js';

const ok = (m) => console.log('  ok  ' + m);

const EMPRESA = {
  name: 'FERNANDO DE CASTRO',
  address: 'GRANJA NOSSA SENHORA APARECIDA, S/N. - GLEBA UBIRATAN - IVINHEMA - MS',
  cpf: 1, tipo_doc: 2, cpf_cnpj: 27233456100, cei: 0,
};

const USUARIOS = [
  {
    name: 'ANDERSON CHIARAPA DE OLIVEIRA ALMEIDA',
    pis: 16122986292, code: 81, templates_count: 2,
    templates: ['TEMPLATE-A', 'TEMPLATE-B'],
    password: '', admin: false, rfid: 81, bars: '0000000081', registration: 0,
  },
  {
    name: 'TESTE', pis: 1, code: 0, templates_count: 1,
    templates: ['TEMPLATE-TESTE'], password: '', admin: false, rfid: 0, bars: '', registration: 0,
  },
];

console.log('\n1) mapearUsuario: formato real do firmware (strings base64)');
{
  const m = mapearUsuario(USUARIOS[0]);
  assert.equal(m.pis, '16122986292');
  assert.equal(m.cpf, null);
  assert.equal(m.tipo, '1510');
  assert.equal(m.codigo, 81);
  assert.equal(m.matricula, 0);
  assert.equal(m.rfid, '81');
  assert.equal(m.barras, '0000000081');
  assert.equal(m.templates.length, 2);
  assert.equal(m.templates[0].tipo, 'digital');
  assert.equal(m.templates[0].indice, 1);
  assert.equal(m.templates[0].dados, 'TEMPLATE-A');
  assert.equal(m.templates[1].indice, 2);
  ok('nome, PIS, código, RFID, barras e 2 digitais mapeados');
}

console.log('\n2) documento curto (código iDCloud) não é funcionário');
{
  assert.equal(documentoValido('1', null), false);
  assert.equal(documentoValido('123', null), false);
  assert.equal(documentoValido('16122986292', null), true);
  assert.equal(documentoValido(null, '12345678901'), true);
  ok('documentos com 6 dígitos ou menos são ignorados');
}

console.log('\n3) importarDoRep grava empresa, funcionários, vínculos e biometria');
{
  const chamadas = { empresas: [], pessoas: [], vinculos: [], templates: [] };
  const client = {
    async importarEmpresa({ idEquipamento, empresa }) {
      chamadas.empresas.push({ idEquipamento, empresa });
      return { id_Empregador: 7, RazaoSocial: empresa.name, CNPJ_CPF: empresa.cpf_cnpj };
    },
    async importarPessoa(p) {
      chamadas.pessoas.push(p);
      return chamadas.pessoas.length;
    },
    async vincularEquipamento(idP, idEquipamento) {
      chamadas.vinculos.push({ idP, idEquipamento });
    },
    async gravarTemplate(idP, tipo, indice, dados) {
      chamadas.templates.push({ idP, tipo, indice, dados });
    },
  };
  const out = await importarDoRep({
    client, idEquipamento: 14003750029470,
    empresa: EMPRESA, usuarios: USUARIOS,
  });

  assert.equal(out.pessoas, 1, 'só o funcionário real deve ser importado');
  assert.equal(out.templates, 2, 'as 2 digitais do funcionário real');
  assert.equal(out.ignorados, 1, 'o usuário de número curto deve ser ignorado');
  assert.equal(chamadas.empresas.length, 1);
  assert.equal(chamadas.empresas[0].empresa.name, 'FERNANDO DE CASTRO');
  assert.equal(chamadas.vinculos.length, 1);
  assert.equal(chamadas.vinculos[0].idEquipamento, 14003750029470);
  assert.equal(chamadas.pessoas[0].portaria, '1510');
  assert.equal(chamadas.pessoas[0].codigo, 81);
  assert.deepEqual(chamadas.templates.map((t) => t.indice), [1, 2]);
  ok('1 empresa, 1 funcionário, 1 vínculo e 2 templates; número curto ignorado');
}

console.log('\n4) importarDoRep sem empresa no REP não quebra');
{
  const client = {
    async importarEmpresa() { throw new Error('não deveria ser chamado'); },
    async importarPessoa() { return 1; },
    async vincularEquipamento() {},
    async gravarTemplate() {},
  };
  const out = await importarDoRep({
    client, idEquipamento: 1, empresa: null, usuarios: [USUARIOS[0]],
  });
  assert.equal(out.empresa, null);
  assert.equal(out.pessoas, 1);
  ok('empresa ausente é tratada como opcional');
}

console.log('\nRESULTADO: TODOS OS TESTES PASSARAM');
