import express, { Request, Response } from 'express';
import { avisos, caminhoDoEnv, config, erroDeConfiguracao } from './config';
import { executar, executarEmTransacao } from './executar';
import { fecharTudo } from './pool';
import { autenticar, filtrarIp, validarSql } from './seguranca';
import type { Banco, Codificacao, PedidoConsulta, PedidoLote } from './tipos';

/**
 * Agente Firebird da Sinsoft.
 *
 * Fica **dentro da prefeitura**, ao lado do banco. Recebe de um sistema da casa
 * a conexão e a consulta, executa no Firebird local e devolve o JSON. Não tem
 * regra de negócio nenhuma — é essa burrice que faz dele algo que se instala uma
 * vez e não se atualiza mais: quando uma consulta muda, quem muda é o sistema
 * que chama, lá na nuvem.
 */
const app = express();

// Os relatórios mandam consultas longas; o padrão de 100 kB do Express é pouco.
app.use(express.json({ limit: '2mb' }));

// Atrás de proxy/túnel o IP real vem no X-Forwarded-For.
app.set('trust proxy', 1);

// Filtro de IP GLOBAL: nem /saude nem /health respondem a IP fora da lista.
app.use(filtrarIp);

app.get(['/saude', '/health'], (_req, res) =>
  res.json({
    ok: true,
    servico: 'agente-firebird',
    somenteLeitura: !config.permitirEscrita,
  })
);

/** Valida a parte comum dos dois endpoints. */
function conferirBanco(banco: Banco | undefined): string | null {
  if (!banco) return 'Faltou o objeto `banco`.';
  if (!banco.host) return 'Faltou `banco.host`.';
  if (!banco.caminho) return 'Faltou `banco.caminho` (o .GDB no servidor da prefeitura).';
  return null;
}

app.post('/consultar', autenticar, async (req: Request, res: Response) => {
  const pedido = req.body as PedidoConsulta;

  const problemaBanco = conferirBanco(pedido?.banco);
  if (problemaBanco) return res.status(400).json({ ok: false, erro: problemaBanco });

  if (typeof pedido?.sql !== 'string') {
    return res.status(400).json({ ok: false, erro: 'Faltou `sql`.' });
  }

  const problemaSql = validarSql(pedido.sql);
  if (problemaSql) return res.status(400).json({ ok: false, erro: problemaSql });

  try {
    const r = await executar(pedido.banco, pedido, pedido.codificacao ?? 'win1252');
    return res.json({ ok: true, ...r });
  } catch (e) {
    const erro = e instanceof Error ? e.message : 'Erro ao consultar o banco';
    console.error('[erro]', erro);
    return res.status(502).json({ ok: false, erro });
  }
});

/**
 * Várias consultas numa requisição só.
 *
 * É o que faz o desenho valer a pena: o Demonstrativo de Educação são 17
 * consultas. Uma a uma, cada ida e volta pela internet somaria ao tempo do
 * relatório; em lote, é **uma** viagem. Por padrão elas rodam em paralelo, como
 * já rodavam quando a API ficava dentro da prefeitura.
 *
 * Uma consulta que falha não derruba as outras: o erro dela vem no lugar dela.
 */
app.post('/lote', autenticar, async (req: Request, res: Response) => {
  const pedido = req.body as PedidoLote;

  const problemaBanco = conferirBanco(pedido?.banco);
  if (problemaBanco) return res.status(400).json({ ok: false, erro: problemaBanco });

  if (!Array.isArray(pedido?.consultas) || pedido.consultas.length === 0) {
    return res.status(400).json({ ok: false, erro: 'Faltou `consultas` (lista não vazia).' });
  }

  for (const c of pedido.consultas) {
    if (typeof c?.sql !== 'string') {
      return res.status(400).json({ ok: false, erro: `Consulta "${c?.nome ?? '?'}" sem \`sql\`.` });
    }
    const problema = validarSql(c.sql);
    if (problema) {
      return res.status(400).json({ ok: false, erro: `Consulta "${c.nome ?? '?'}": ${problema}` });
    }
  }

  const codificacao: Codificacao = pedido.codificacao ?? 'win1252';
  const inicio = Date.now();

  /**
   * Tudo ou nada, para quem grava.
   *
   * Um cadastro que insere a dívida e depois as parcelas não pode deixar a
   * dívida sem parcelas se a segunda falhar. Aqui as consultas dividem uma
   * conexão e uma transação: qualquer erro desfaz o conjunto, e a resposta é um
   * erro só — não faria sentido devolver "a 1ª deu certo" se ela foi desfeita.
   */
  if (pedido.transacao) {
    try {
      const linhas = await executarEmTransacao(pedido.banco, pedido.consultas, codificacao);
      return res.json({
        ok: true,
        resultados: pedido.consultas.map((c, i) => ({ nome: c.nome, ...linhas[i] })),
        ms: Date.now() - inicio,
      });
    } catch (e) {
      const erro = e instanceof Error ? e.message : 'Erro na transação';
      console.error('[erro] transação desfeita:', erro);
      return res.status(502).json({ ok: false, erro, desfeito: true });
    }
  }

  const rodar = async (c: (typeof pedido.consultas)[number]) => {
    try {
      const r = await executar(pedido.banco, c, codificacao);
      return { nome: c.nome, ...r };
    } catch (e) {
      return {
        nome: c.nome,
        ms: 0,
        erro: e instanceof Error ? e.message : 'Erro ao consultar o banco',
      };
    }
  };

  const emParalelo = pedido.emParalelo !== false;
  const resultados = emParalelo
    ? await Promise.all(pedido.consultas.map(rodar))
    : await pedido.consultas.reduce(
        async (anterior, c) => [...(await anterior), await rodar(c)],
        Promise.resolve([] as Awaited<ReturnType<typeof rodar>>[])
      );

  const ms = Date.now() - inicio;
  console.log(`[lote] ${pedido.consultas.length} consultas em ${ms}ms`);
  return res.json({ ok: true, resultados, ms });
});

app.use((_req, res) => res.status(404).json({ ok: false, erro: 'Rota inexistente' }));

/**
 * Erro sempre em JSON.
 *
 * Sem isto, um corpo malformado faz o Express devolver uma página HTML com stack
 * trace — quem chama está esperando JSON e recebe lixo, e ainda por cima o
 * caminho dos arquivos do servidor vaza na resposta.
 */
app.use((erro: Error, _req: Request, res: Response, _proximo: express.NextFunction) => {
  const ehJsonRuim = erro instanceof SyntaxError && 'body' in erro;
  if (ehJsonRuim) {
    res.status(400).json({ ok: false, erro: 'Corpo da requisição não é um JSON válido.' });
    return;
  }
  console.error('[erro]', erro.message);
  res.status(500).json({ ok: false, erro: 'Erro interno do agente' });
});

const problema = erroDeConfiguracao();
if (problema) {
  console.error(`[FATAL] ${problema}`);
  console.error(`Arquivo esperado: ${caminhoDoEnv}`);
  process.exit(1);
}

const servidor = app.listen(config.porta, () => {
  console.log(`Agente Firebird da Sinsoft em http://localhost:${config.porta}`);
  console.log(`Configuração lida de: ${caminhoDoEnv}`);
  console.log(`Modo: ${config.permitirEscrita ? 'LEITURA E ESCRITA' : 'somente leitura'}`);
  for (const aviso of avisos()) console.warn(`[ATENÇÃO] ${aviso}`);
});

function encerrar() {
  servidor.close(() => {
    fecharTudo();
    process.exit(0);
  });
}
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
