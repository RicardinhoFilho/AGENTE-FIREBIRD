/**
 * O contrato entre os sistemas da Sinsoft e o agente.
 *
 * Quem chama diz **onde é o banco** e **o que executar**; o agente conecta no
 * Firebird da rede local dele e devolve o JSON. Nada de regra de negócio aqui:
 * o agente é burro de propósito, para nunca mais precisar ser atualizado quando
 * uma consulta muda.
 */

/** Onde fica o Firebird. Vem de `configuracoes_bancos_desktop`, do lado de quem chama. */
export interface Banco {
  host: string;
  porta?: number;
  /** Caminho do .GDB **no servidor da prefeitura**, não no de quem chama. */
  caminho: string;
  /** "1.5" ou "3.0" — decide a senha do SYSDBA. */
  versao?: string | number;
  /**
   * Charset da conexão. O padrão é NONE porque as bases da casa guardam bytes
   * WIN1252 em colunas declaradas NONE; pedir UTF8 estoura no primeiro acento.
   */
  charset?: string;
  /**
   * Lê BLOB de texto já como string. Necessário no Firebird 1.5, que não aceita
   * CAST(blob AS VARCHAR) — sem isto o driver devolve uma função e o campo some
   * do JSON.
   */
  blobComoTexto?: boolean;
  /**
   * Credenciais proprias, quando o banco nao usa o SYSDBA da casa.
   *
   * Omitidos, valem `SYSDBA` + a senha deduzida da `versao` — o comportamento
   * de sempre. Servem para bancos que moram numa VM com senha diferente.
   */
  usuario?: string;
  senha?: string;
}

/**
 * Como o texto volta.
 *
 * As bases são charset NONE guardando bytes de uma tabela de 8 bits, então o
 * driver entrega `Buffer`. Quem chama diz em que alfabeto quer ler:
 *
 * - `win1252` — o que o RELATORIO usa (lê `CAST(... CHARACTER SET OCTETS)`)
 * - `latin1`  — o que a ARRECADACAO usa
 * - `base64`  — devolve o byte cru, para quem quiser decodificar por conta
 */
export type Codificacao = 'win1252' | 'latin1' | 'base64';

export interface Consulta {
  /** Só para achar o resultado na resposta do lote. */
  nome?: string;
  sql: string;
  /** Valores dos `?`, na ordem. Datas podem vir como ISO. */
  parametros?: unknown[];
}

export interface PedidoConsulta extends Consulta {
  banco: Banco;
  codificacao?: Codificacao;
}

export interface PedidoLote {
  banco: Banco;
  consultas: Consulta[];
  codificacao?: Codificacao;
  /**
   * Roda as consultas ao mesmo tempo. É o padrão: o lote existe justamente para
   * matar a ida e volta pela internet, e os relatórios já disparam as consultas
   * em paralelo do outro lado.
   */
  emParalelo?: boolean;
  /**
   * Roda tudo numa transação só: qualquer erro desfaz o conjunto.
   *
   * É o que um cadastro precisa — inserir a dívida e depois as parcelas não pode
   * deixar a dívida sem parcelas. Implica sequência; `emParalelo` é ignorado.
   */
  transacao?: boolean;
}

export interface RespostaConsulta {
  ok: true;
  linhas: Record<string, unknown>[];
  /** Quantas linhas vieram. Se bateu o teto, `cortado` avisa. */
  total: number;
  cortado?: boolean;
  ms: number;
}

export interface RespostaLote {
  ok: true;
  /** Uma entrada por consulta, na ordem em que foram mandadas. */
  resultados: {
    nome?: string;
    linhas?: Record<string, unknown>[];
    total?: number;
    cortado?: boolean;
    ms: number;
    erro?: string;
  }[];
  ms: number;
}

export interface RespostaErro {
  ok: false;
  erro: string;
}

/**
 * Backup: quem chama diz so QUAL banco. O destino (FTP) e do agente, nunca do
 * pedido — ver a explicacao em `config.ts`.
 */
export interface PedidoBackup {
  banco: Banco;
  /**
   * Vira a subpasta no FTP: `agente_firebird/<municipio>/`. Obrigatorio — sem
   * ele os arquivos de todas as prefeituras cairiam no mesmo monte.
   */
  municipio: string;
  /** Vira o comeco do nome do arquivo no FTP. Padrao: o nome do .GDB. */
  nome?: string;
}

/**
 * Em que pe esta o backup.
 *
 * `gerando` costuma ser a etapa longa: e o gbak lendo a base inteira.
 */
export type EstadoBackup = 'gerando' | 'compactando' | 'enviando' | 'pronto' | 'erro';

export interface Backup {
  id: string;
  estado: EstadoBackup;
  /** Nome do arquivo no FTP. So existe a partir de `enviando`. */
  arquivo?: string;
  /** Pasta no FTP, ja higienizada — pode diferir do que veio no pedido. */
  municipio: string;
  banco: string;
  criadoEm: string;
  terminadoEm?: string;
  ms?: number;
  bytesFbk?: number;
  bytesZip?: number;
  /** Ultima linha do gbak, ou os bytes ja enviados. Serve para saber que anda. */
  progresso?: string;
  erro?: string;
}
