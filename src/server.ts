import express, { Request, Response } from 'express';
import {
  backupEmAndamento,
  iniciarBackup,
  listarBackups,
  obterBackup,
} from './backup';
import { avisos, caminhoDoEnv, config, erroDeConfiguracao } from './config';
import { executar, executarEmTransacao } from './executar';
import { fecharTudo } from './pool';
import { autenticar, filtrarIp, validarSql } from './seguranca';
import type {
  Banco,
  Codificacao,
  PedidoBackup,
  PedidoConsulta,
  PedidoLote,
} from './tipos';

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

/**
 * Atrás de proxy/túnel o IP real vem no X-Forwarded-For.
 *
 * A lista (em vez de um número de saltos) faz o express andar pela cadeia de
 * trás para frente **pulando todo endereço privado** e parar no primeiro
 * público — funciona igual com o agente direto na porta, com um nginx na
 * frente, ou com nginx + firewall/proxy da prefeitura somando um salto extra.
 * Com `trust proxy: 1` esse último caso entregava o IP interno do proxy, e o
 * filtro de IPS_PERMITIDOS recusava tudo, viesse de onde viesse.
 *
 * Só endereço privado é confiado, então ninguém de fora forja o header.
 */
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

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

/**
 * Backup da base para o FTP da Sinsoft.
 *
 * Responde **202 na hora**, com um `id`: o gbak de uma base de prefeitura passa
 * de meia hora, e nenhuma requisicao HTTP atravessa isso. O andamento sai em
 * `GET /backup/:id`.
 *
 * O destino nao vem no pedido, so o banco — o porque esta no `config.ts`.
 */
app.post('/backup', autenticar, (req: Request, res: Response) => {
  if (!config.permitirBackup) {
    return res.status(403).json({
      ok: false,
      erro: 'Backup desligado neste agente. Ligue PERMITIR_BACKUP no .env.',
    });
  }

  const pedido = req.body as PedidoBackup;

  const problemaBanco = conferirBanco(pedido?.banco);
  if (problemaBanco) return res.status(400).json({ ok: false, erro: problemaBanco });

  if (typeof pedido?.municipio !== 'string' || !pedido.municipio.trim()) {
    return res.status(400).json({
      ok: false,
      erro: 'Faltou `municipio` — é a subpasta no FTP. Ex.: "HERVEIRAS".',
    });
  }

  try {
    const backup = iniciarBackup(pedido.banco, pedido.municipio, pedido.nome);
    return res.status(202).json({ ok: true, ...backup });
  } catch (e) {
    const erro = e instanceof Error ? e.message : 'Nao consegui iniciar o backup';
    console.error('[backup]', erro);
    // 409 e "tem um rodando"; o resto e pedido que nao da para atender.
    return res.status(backupEmAndamento() ? 409 : 400).json({ ok: false, erro });
  }
});

app.get('/backup', autenticar, (_req: Request, res: Response) =>
  res.json({ ok: true, backups: listarBackups(), emAndamento: backupEmAndamento() })
);

app.get('/backup/:id', autenticar, (req: Request, res: Response) => {
  const backup = obterBackup(req.params.id);
  if (!backup) return res.status(404).json({ ok: false, erro: 'Backup nao encontrado.' });
  return res.json({ ok: true, ...backup });
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

// ──────────────────────────────────────────────────────────────────────────────
// Rede de segurança: o agente atende VÁRIOS sistemas ao mesmo tempo. Uma exceção
// não tratada — ex.: o driver node-firebird estourando ao falar com uma versão de
// Firebird para a qual o patch não foi feito — NÃO pode derrubar o processo e
// tirar todos os municípios do ar. Aqui a gente loga e segue vivo; a requisição
// que causou já terá falhado (ou expira pelo timeout da consulta).
// ──────────────────────────────────────────────────────────────────────────────
process.on('uncaughtException', (erro) => {
  console.error('[uncaughtException] agente mantido no ar:', erro instanceof Error ? erro.message : erro);
});
process.on('unhandledRejection', (motivo) => {
  console.error('[unhandledRejection] agente mantido no ar:', motivo instanceof Error ? motivo.message : motivo);
});
