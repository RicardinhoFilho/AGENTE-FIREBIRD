import Firebird from 'node-firebird';
import { config } from './config';
import { obterPool } from './pool';
import type { Banco, Codificacao, Consulta } from './tipos';
import iconv from 'iconv-lite';

// iconv-lite (JS puro) em vez de TextDecoder: o binario Node do pkg vem com ICU
// reduzido (so UTF-8), entao windows-1252/latin1 nao existem la e o TextDecoder
// estoura no exe. iconv-lite nao depende de ICU e decodifica igual.
const nomeIconv: Record<Exclude<Codificacao, 'base64'>, string> = {
  win1252: 'win1252',
  latin1: 'latin1',
};

/**
 * Converte o que o driver devolveu no que vai no JSON.
 *
 * As bases da casa são charset NONE guardando bytes de 8 bits, então texto chega
 * como `Buffer` — e `Buffer` no `JSON.stringify` viraria `{"type":"Buffer",...}`,
 * que não serve para ninguém. Aqui vira string no alfabeto que quem chamou
 * pediu. Quem preferir decodificar do outro lado pede `base64` e recebe o byte
 * cru.
 *
 * Firebird preenche CHAR com `\0` e espaços à direita; os dois saem fora.
 */
function converter(valor: unknown, codificacao: Codificacao): unknown {
  if (valor === null || valor === undefined) return valor;

  if (Buffer.isBuffer(valor) || valor instanceof Uint8Array) {
    const buf = Buffer.isBuffer(valor) ? valor : Buffer.from(valor);
    if (codificacao === 'base64') return buf.toString('base64');
    return iconv.decode(buf, nomeIconv[codificacao]).replace(/\0/g, '').trimEnd();
  }

  // datas viram ISO no JSON; números e booleanos passam direto
  return valor;
}

function converterLinha(
  linha: Record<string, unknown>,
  codificacao: Codificacao
): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const campo of Object.keys(linha)) saida[campo] = converter(linha[campo], codificacao);
  return saida;
}

/**
 * Datas chegam do outro lado como texto ISO (o JSON não tem tipo data).
 * O driver espera `Date` para comparar com colunas DATE/TIMESTAMP.
 */
function prepararParametros(parametros: unknown[]): unknown[] {
  return parametros.map(p => {
    if (typeof p === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(p)) {
      const d = new Date(p);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return p;
  });
}

/** Resume a SQL numa linha, para o log ficar legível. */
function resumir(sql: string): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

export interface Resultado {
  linhas: Record<string, unknown>[];
  total: number;
  cortado: boolean;
  ms: number;
}

export async function executar(
  banco: Banco,
  consulta: Consulta,
  codificacao: Codificacao = 'win1252'
): Promise<Resultado> {
  const pool = await obterPool(banco);
  const inicio = Date.now();

  return new Promise<Resultado>((resolve, reject) => {
    pool.get((erroConexao: Error | null, db: Firebird.Database) => {
      if (erroConexao) return reject(traduzir(erroConexao, banco));

      let terminou = false;
      // Devolve a conexão ao pool. Sem isto, cada consulta que estoura o tempo
      // vaza uma conexão e o pool esgota — depois de 5, tudo trava.
      const soltar = () => {
        try {
          db.detach();
        } catch {
          /* ignore */
        }
      };
      const encerrar = (erro: Error | null, r?: Resultado) => {
        if (terminou) return;
        terminou = true;
        clearTimeout(cronometro);
        soltar();
        if (erro) reject(erro);
        else resolve(r!);
      };

      const cronometro = setTimeout(
        () =>
          encerrar(
            new Error(`A consulta passou de ${config.timeoutMs}ms e foi interrompida.`)
          ),
        config.timeoutMs
      );

      db.query(
        consulta.sql,
        prepararParametros(consulta.parametros ?? []) as never[],
        (erro: Error | null, resultado: unknown) => {
          if (erro) return encerrar(erro);

          const brutas = Array.isArray(resultado)
            ? (resultado as Record<string, unknown>[])
            : [];
          const cortado = brutas.length > config.maxLinhas;
          const usadas = cortado ? brutas.slice(0, config.maxLinhas) : brutas;
          const ms = Date.now() - inicio;

          console.log(
            `[query] ${ms}ms ${brutas.length} linhas${cortado ? ' (CORTADO)' : ''}: ${resumir(consulta.sql)}`
          );

          encerrar(null, {
            linhas: usadas.map(l => converterLinha(l, codificacao)),
            total: usadas.length,
            cortado,
            ms,
          });
        }
      );
    });
  });
}

/**
 * Roda várias consultas **numa transação só**.
 *
 * Sem isto, um gravador que insere a dívida e depois as parcelas pode deixar a
 * dívida no banco sem as parcelas se a segunda falhar — cada consulta pega a sua
 * conexão e faz commit sozinha. Aqui as consultas dividem uma conexão e uma
 * transação: se alguma quebrar, tudo volta atrás.
 *
 * Rodam em sequência por definição — dentro de uma transação não faz sentido
 * paralelizar.
 */
export async function executarEmTransacao(
  banco: Banco,
  consultas: Consulta[],
  codificacao: Codificacao = 'win1252'
): Promise<Resultado[]> {
  const pool = await obterPool(banco);
  const inicio = Date.now();

  const db = await new Promise<Firebird.Database>((resolve, reject) => {
    pool.get((erro: Error | null, conexao: Firebird.Database) =>
      erro ? reject(traduzir(erro, banco)) : resolve(conexao)
    );
  });

  const transacao = await new Promise<Firebird.Transaction>((resolve, reject) => {
    db.transaction(Firebird.ISOLATION_READ_COMMITTED, (erro: Error | null, t: Firebird.Transaction) =>
      erro ? reject(erro) : resolve(t)
    );
  });

  const rodar = (c: Consulta) =>
    new Promise<Resultado>((resolve, reject) => {
      const marca = Date.now();
      transacao.query(
        c.sql,
        prepararParametros(c.parametros ?? []) as never[],
        (erro: Error | null, resultado: unknown) => {
          if (erro) return reject(erro);
          const brutas = Array.isArray(resultado) ? (resultado as Record<string, unknown>[]) : [];
          const cortado = brutas.length > config.maxLinhas;
          const usadas = cortado ? brutas.slice(0, config.maxLinhas) : brutas;
          resolve({
            linhas: usadas.map(l => converterLinha(l, codificacao)),
            total: usadas.length,
            cortado,
            ms: Date.now() - marca,
          });
        }
      );
    });

  const encerrar = (acao: 'commit' | 'rollback') =>
    new Promise<void>(resolve => {
      transacao[acao](() => {
        try {
          db.detach();
        } catch {
          /* ignore */
        }
        resolve();
      });
    });

  try {
    const resultados: Resultado[] = [];
    for (const c of consultas) resultados.push(await rodar(c));
    await encerrar('commit');
    console.log(`[transacao] ${consultas.length} consultas em ${Date.now() - inicio}ms (commit)`);
    return resultados;
  } catch (e) {
    await encerrar('rollback');
    console.warn(
      `[transacao] desfeita após ${Date.now() - inicio}ms: ${(e as Error).message ?? e}`
    );
    throw e;
  }
}

/**
 * Traduz os erros de conexão que aparecem quando o cadastro do banco está
 * errado. O driver devolve mensagens que não dizem onde olhar.
 */
function traduzir(erro: Error, banco: Banco): Error {
  const msg = erro.message ?? '';

  if (/user name and password|password.*not defined|login/i.test(msg)) {
    return new Error(
      `O Firebird recusou o SYSDBA em ${banco.caminho}. A senha é deduzida da versão ` +
        `informada (${banco.versao ?? 'não informada'}): 1.5 → masterkey, 3 → SIN_S1_S2. ` +
        'Confira o campo `versao` do cadastro.'
    );
  }
  if (/No such file|não foi possível|unavailable database|I\/O error/i.test(msg)) {
    return new Error(
      `Não achei o banco em ${banco.caminho}. Esse caminho é o do servidor da ` +
        'prefeitura, visto pelo próprio Firebird — não o do computador que chamou.'
    );
  }
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND/i.test(msg)) {
    return new Error(
      `Não consegui falar com o Firebird em ${banco.host}:${banco.porta ?? 3050}. ` +
        'Verifique se o serviço está no ar e se a porta está liberada.'
    );
  }
  return erro;
}
