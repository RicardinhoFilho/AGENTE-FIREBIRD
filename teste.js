/**
 * Exercita o agente contra o SIAFIC2026 local.
 *
 *   node teste.js            (usa a chave do .env)
 */
require('dotenv').config();

const BASE = `http://localhost:${process.env.PORT ?? 3060}`;
const CHAVE = process.env.AGENTE_CHAVE;

const BANCO = {
  host: 'localhost',
  porta: 3051,
  caminho: 'C:\\Users\\ricar\\Desktop\\Sinsoft\\MIGRACAO\\RELATORIO\\BANCOS\\SIAFIC2026.GDB',
  // no cadastro real esta base é 3.0, mas a instalação local usa masterkey
  versao: '1.5',
};

async function chamar(rota, corpo, chave = CHAVE) {
  const r = await fetch(BASE + rota, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(chave ? { Authorization: `Bearer ${chave}` } : {}),
    },
    body: JSON.stringify(corpo),
  });
  const texto = await r.text();
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    json = { naoEraJson: texto.slice(0, 120) };
  }
  return { status: r.status, json };
}

const mostrar = (titulo, { status, json }) => {
  const resumo = json.erro
    ? json.erro
    : json.linhas
      ? `${json.total} linhas em ${json.ms}ms -> ${JSON.stringify(json.linhas[0] ?? {}).slice(0, 90)}`
      : json.resultados
        ? json.resultados.map(r => `${r.nome}:${r.erro ? 'ERRO ' + r.erro.slice(0, 40) : r.total}`).join('  ')
        : JSON.stringify(json).slice(0, 120);
  console.log(`${String(status).padEnd(4)} ${titulo.padEnd(34)} ${resumo}`);
};

async function principal() {
  const SQL_ORGAOS =
    'SELECT FIRST 2 CAST(DEPTO AS VARCHAR(60) CHARACTER SET OCTETS) AS DEPTO FROM ORGAOS';

  mostrar('sem chave', await chamar('/consultar', { banco: BANCO, sql: SQL_ORGAOS }, null));
  mostrar('chave errada', await chamar('/consultar', { banco: BANCO, sql: SQL_ORGAOS }, 'errada'));
  mostrar('sem banco', await chamar('/consultar', { sql: SQL_ORGAOS }));
  mostrar('SELECT com acento', await chamar('/consultar', { banco: BANCO, sql: SQL_ORGAOS }));

  mostrar(
    'DELETE (so-leitura)',
    await chamar('/consultar', { banco: BANCO, sql: 'DELETE FROM ANUAL' })
  );
  mostrar(
    'DELETE atras de comentario',
    await chamar('/consultar', { banco: BANCO, sql: '/* ok */ DELETE FROM ANUAL' })
  );
  mostrar(
    'dois comandos',
    await chamar('/consultar', { banco: BANCO, sql: 'SELECT 1 FROM RDB$DATABASE; DROP TABLE ANUAL' })
  );

  mostrar(
    'parametro data',
    await chamar('/consultar', {
      banco: BANCO,
      sql: 'SELECT COUNT(*) AS N FROM ANULIQ WHERE DATA >= ? AND DATA <= ?',
      parametros: ['2026-07-01', '2026-07-30'],
    })
  );

  // O ponto sensível: as bases guardam bytes WIN1252 em colunas charset NONE.
  // Se a decodificação estiver errada, é aqui que o acento vira lixo.
  const SQL_ACENTO =
    'SELECT FIRST 2 CAST(DEPTO AS VARCHAR(60) CHARACTER SET OCTETS) AS D ' +
    "FROM ORGAOS WHERE DEPTO LIKE '%EDUCA%'";
  for (const codificacao of ['win1252', 'latin1', 'base64']) {
    const { status, json } = await chamar('/consultar', {
      banco: BANCO,
      sql: SQL_ACENTO,
      codificacao,
    });
    const texto = json.linhas ? json.linhas.map(l => l.D).join(' | ') : json.erro;
    console.log(`${String(status).padEnd(4)} acento em ${codificacao.padEnd(24)} ${texto}`);
  }

  mostrar(
    'banco inexistente',
    await chamar('/consultar', {
      banco: { ...BANCO, caminho: 'C:\\nao\\existe.GDB' },
      sql: SQL_ORGAOS,
    })
  );

  // o lote: é ele que paga o desenho, matando a ida e volta pela internet
  const lote = await chamar('/lote', {
    banco: BANCO,
    consultas: [
      { nome: 'orgaos', sql: SQL_ORGAOS },
      { nome: 'empenhos', sql: "SELECT COUNT(*) AS N FROM ANUAL WHERE CODIGO4 = '5'" },
      { nome: 'liquidacoes', sql: 'SELECT COUNT(*) AS N FROM ANULIQ' },
      { nome: 'quebrada', sql: 'SELECT * FROM TABELA_QUE_NAO_EXISTE' },
    ],
  });
  mostrar('lote (4, uma quebrada)', lote);
  console.log(`     lote inteiro em ${lote.json.ms}ms`);
}

principal().catch(e => {
  console.error(e);
  process.exit(1);
});
