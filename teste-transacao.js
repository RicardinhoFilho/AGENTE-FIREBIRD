/**
 * Prova que o lote transacional desfaz de verdade.
 *
 * Cria uma tabela de brinquedo, tenta gravar duas linhas onde a **segunda**
 * falha, e confere que a primeira NÃO ficou no banco. É o caso do ARRECADACAO:
 * inserir a dívida e depois as parcelas.
 *
 * Precisa do agente com PERMITIR_ESCRITA=true.
 *
 *   node teste-transacao.js
 */
require('dotenv').config();
const Firebird = require('node-firebird');

const BASE = `http://localhost:${process.env.PORT ?? 3060}`;
const CHAVE = process.env.AGENTE_CHAVE;
const CAMINHO = 'C:\\Users\\ricar\\Desktop\\Sinsoft\\MIGRACAO\\RELATORIO\\BANCOS\\SIAFIC2026.GDB';
const BANCO = { host: 'localhost', porta: 3051, caminho: CAMINHO, versao: '1.5' };

const opcoes = {
  host: 'localhost',
  port: 3051,
  database: CAMINHO,
  user: 'SYSDBA',
  password: 'masterkey',
  charset: 'NONE',
};

/** DDL não passa pelo agente (de propósito), então vai direto pelo driver. */
function direto(sql) {
  return new Promise((resolve, reject) => {
    Firebird.attach(opcoes, (e, db) => {
      if (e) return reject(e);
      db.query(sql, [], (erro, r) => {
        db.detach();
        if (erro) reject(erro);
        else resolve(r);
      });
    });
  });
}

async function lote(consultas, transacao) {
  const r = await fetch(BASE + '/lote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAVE}` },
    body: JSON.stringify({ banco: BANCO, consultas, transacao }),
  });
  return { status: r.status, json: await r.json() };
}

const contar = async () =>
  (await direto('SELECT COUNT(*) AS N FROM TESTE_AGENTE'))[0].N;

async function principal() {
  await direto('RECREATE TABLE TESTE_AGENTE (ID INTEGER NOT NULL PRIMARY KEY)').catch(() => {});
  await direto('DELETE FROM TESTE_AGENTE');
  console.log('linhas no começo         :', await contar());

  // 1) as duas dão certo -> commit
  const ok = await lote(
    [
      { nome: 'a', sql: 'INSERT INTO TESTE_AGENTE (ID) VALUES (1)' },
      { nome: 'b', sql: 'INSERT INTO TESTE_AGENTE (ID) VALUES (2)' },
    ],
    true
  );
  console.log('lote que dá certo        :', ok.status, '->', await contar(), 'linhas (esperado 2)');

  // 2) a segunda viola a chave -> a primeira NÃO pode ficar
  const falha = await lote(
    [
      { nome: 'a', sql: 'INSERT INTO TESTE_AGENTE (ID) VALUES (3)' },
      { nome: 'b', sql: 'INSERT INTO TESTE_AGENTE (ID) VALUES (1)' }, // já existe
    ],
    true
  );
  console.log(
    'lote que falha           :',
    falha.status,
    falha.json.desfeito ? '(desfeito)' : '',
    '->',
    await contar(),
    'linhas (esperado 2 — o 3 não pode ter entrado)'
  );

  // 3) o mesmo SEM transação: aí a primeira fica mesmo, e é esse o risco
  const semTransacao = await lote(
    [
      { nome: 'a', sql: 'INSERT INTO TESTE_AGENTE (ID) VALUES (9)' },
      { nome: 'b', sql: 'INSERT INTO TESTE_AGENTE (ID) VALUES (1)' },
    ],
    false
  );
  console.log(
    'lote sem transação       :',
    semTransacao.status,
    '->',
    await contar(),
    'linhas (esperado 3 — a primeira ficou)'
  );

  // 4) DDL nunca passa, nem com escrita ligada
  const ddl = await lote([{ nome: 'ddl', sql: 'DROP TABLE TESTE_AGENTE' }], false);
  console.log('DROP pelo agente         :', ddl.status, '->', ddl.json.erro);

  await direto('DROP TABLE TESTE_AGENTE').catch(() => {});
  console.log('\ntabela de teste removida.');
}

principal().then(
  () => process.exit(0),
  e => {
    console.error(e);
    process.exit(1);
  }
);
