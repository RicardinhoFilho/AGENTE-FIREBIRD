import Firebird from 'node-firebird';
import { config } from './config';
import type { Banco } from './tipos';

/**
 * Um pool por banco.
 *
 * O agente atende vários sistemas e, às vezes, mais de um exercício
 * (`SIAFIC2026`, `SIAFIC2027`) do mesmo servidor. Abrir conexão a cada consulta
 * seria caro; guardar um pool por destino resolve.
 *
 * Guarda-se a **Promise**: duas requisições simultâneas para o mesmo banco
 * compartilham a abertura em vez de criarem dois pools.
 */
const pools = new Map<string, Promise<Firebird.ConnectionPool>>();

/**
 * A senha do SYSDBA, deduzida da versão do Firebird — mesma regra dos outros
 * sistemas da casa. A coluna `versao` vem escrita de jeitos diferentes ("3.0",
 * "3", "1.5"), então o que vale é o número maior dela, não o texto.
 */
export function senhaPorVersao(versao: string | number | undefined): string {
  const maior = Number(String(versao ?? '').match(/(\d+)/)?.[1]);
  return maior >= 3 ? config.senhaV3 : config.senhaV15;
}

/** `SYSDBA` + senha da versao, salvo quando o pedido trouxer credencial propria. */
export function usuarioDe(banco: Banco): string {
  return banco.usuario?.trim() || 'SYSDBA';
}

export function senhaDe(banco: Banco): string {
  return banco.senha ?? senhaPorVersao(banco.versao);
}

/**
 * O usuario entra na chave junto com o destino.
 *
 * Sem ele, dois sistemas pedindo o MESMO banco com credenciais diferentes
 * receberiam o mesmo pool — o de quem chegou primeiro — e o segundo herdaria a
 * permissao do primeiro sem nenhum sinal de que isso aconteceu.
 */
function chaveDo(banco: Banco): string {
  return `${usuarioDe(banco)}@${banco.host}:${banco.porta ?? 3050}:${banco.caminho}`;
}

function opcoes(banco: Banco): Firebird.Options {
  return {
    host: banco.host,
    port: Number(banco.porta) || 3050,
    database: banco.caminho,
    user: usuarioDe(banco),
    password: senhaDe(banco),
    lowercase_keys: false,
    pageSize: 4096,
    // `charset` é o alfabeto em que o driver DECODIFICA strings do lado JS.
    // `encoding` é o que vira o lc_ctype DA CONEXÃO (connection.js usa
    // `options.encoding || 'UTF8'`). Sem ele, a conexão caía em UTF8 e as bases
    // charset NONE (bytes WIN1252) estouravam "Malformed string" no 1º acento
    // fora de OCTETS — sobretudo no Firebird 3, que valida o charset. Fixar os
    // dois em NONE é o correto: NONE = sem transliteração, bytes crus.
    charset: banco.charset ?? 'NONE',
    encoding: banco.charset ?? 'NONE',
    blobAsText: banco.blobComoTexto ?? true,
  } as Firebird.Options;
}

export function obterPool(banco: Banco): Promise<Firebird.ConnectionPool> {
  const chave = chaveDo(banco);
  const existente = pools.get(chave);
  if (existente) return existente;

  const promessa = Promise.resolve(Firebird.pool(config.tamanhoPool, opcoes(banco)));
  // Falhou ao abrir? Sai do cache, para a próxima requisição tentar de novo em
  // vez de repetir o mesmo erro para sempre.
  promessa.catch(() => pools.delete(chave));
  pools.set(chave, promessa);

  console.log(`[pool] aberto para ${chave} (Firebird ${banco.versao ?? '?'})`);
  return promessa;
}

/** Fecha tudo — usado no encerramento do processo. */
export function fecharTudo(): void {
  for (const promessa of pools.values()) {
    promessa
      .then(p => {
        try {
          p.destroy();
        } catch {
          /* nada a fazer */
        }
      })
      .catch(() => {
        /* pool que nem chegou a abrir */
      });
  }
  pools.clear();
}
