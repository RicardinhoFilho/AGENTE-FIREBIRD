import path from 'path';
import dotenv from 'dotenv';

/**
 * Onde está o `.env`.
 *
 * Empacotado como `.exe`, o código roda de um sistema de arquivos virtual e
 * `__dirname` aponta para dentro do próprio executável — o `.env` precisa ser
 * procurado **ao lado do .exe**, que é onde quem instala vai deixá-lo. Rodando
 * pelo `ts-node`, vale a raiz do projeto.
 */
const empacotado = Boolean((process as { pkg?: unknown }).pkg);
const pastaDoEnv = empacotado
  ? path.dirname(process.execPath)
  : path.resolve(__dirname, '..');

dotenv.config({ path: path.join(pastaDoEnv, '.env') });

/**
 * IPs autorizados FIXOS no fonte (servidores da Sinsoft). Como sao os mesmos em
 * TODA prefeitura e mudam raramente, ficam aqui — mais facil de manter/versionar
 * e ninguem esquece de configurar no cliente. Para um IP pontual de uma
 * instalacao, sem rebuildar, ainda da para somar em IPS_PERMITIDOS no .env.
 *
 * >>> EDITE ESTA LISTA quando um servidor da Sinsoft mudar de IP. <<<
 */
const IPS_FIXOS: string[] = [
  '191.252.64.232',   // servidor Linux (nuvem, onde rodam as APIs)
  '162.120.186.185',  // Sinsoft (maquina de testes)
  '201.130.94.250',   // novo IP autorizado
];

/**
 * CONFIG FIXA NO FONTE — o exe roda SEM .env.
 *
 * Estes valores sao os padroes embutidos. Um .env ao lado do exe, SE existir,
 * ainda sobrepoe (util para um ajuste pontual sem rebuildar); mas nao e mais
 * necessario. A chave fica a mesma em todas as prefeituras — compilada no exe.
 */
const CHAVE_FIXA = 'b8798b02d50256251d8b9a9ce4e149d62cd8513efa38479c4ffc64c7ff8a2c33';
const PORTA_PADRAO = 3060;
const PERMITIR_ESCRITA_PADRAO = true;   // troque para false se os sistemas so leem

/** Mostrado no log, para quem instala saber qual arquivo o agente leu. */
export const caminhoDoEnv = path.join(pastaDoEnv, '.env');

function booleano(nome: string, padrao: boolean): boolean {
  const valor = process.env[nome];
  if (valor === undefined || valor === '') return padrao;
  return valor.toLowerCase() === 'true' || valor === '1';
}

function lista(nome: string): string[] {
  return (process.env[nome] ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

export const config = {
  porta: Number(process.env.PORT ?? PORTA_PADRAO),

  /**
   * Chave que os sistemas da Sinsoft mandam no `Authorization: Bearer`.
   *
   * Sem ela o agente **não sobe**: ele executa SQL num banco de prefeitura, e um
   * agente aberto na rede é um banco aberto na rede.
   */
  chave: (process.env.AGENTE_CHAVE || CHAVE_FIXA).trim(),

  /** Se preenchido, só estes IPs podem chamar. Vazio = qualquer um com a chave. */
  ipsPermitidos: [...new Set([...IPS_FIXOS, ...lista('IPS_PERMITIDOS')])],

  /**
   * Deixa passar comando que **escreve**.
   *
   * Por padrão o agente é só-leitura: recusa qualquer coisa que não seja SELECT.
   * Os relatórios só leem, e um agente que só lê não tem como destruir um
   * exercício inteiro se a chave vazar. Ligue apenas se um sistema precisar
   * gravar de verdade — e, nesse caso, prefira restringir também no Firebird,
   * com um usuário sem permissão de escrita.
   */
  permitirEscrita: booleano('PERMITIR_ESCRITA', PERMITIR_ESCRITA_PADRAO),

  /** Corta a consulta que passar disto. Protege memória e o link da prefeitura. */
  maxLinhas: Number(process.env.MAX_LINHAS ?? 200000),

  /** Tempo máximo de uma consulta. */
  timeoutMs: Number(process.env.TIMEOUT_MS ?? 120000),

  /** Quantas conexões por banco. */
  tamanhoPool: Number(process.env.TAMANHO_POOL ?? 5),

  /**
   * Senha do SYSDBA por versão do Firebird — a mesma regra dos outros sistemas
   * da casa: 1.5 → masterkey, 3.x → SIN_S1_S2.
   */
  senhaV3: process.env.FB_SENHA_V3 ?? 'SIN_S1_S2',
  senhaV15: process.env.FB_SENHA_V15 ?? 'masterkey',
};

/** O que impede o agente de subir. */
export function erroDeConfiguracao(): string | null {
  if (!config.chave) {
    return (
      'AGENTE_CHAVE vazio. O agente executa SQL no banco da prefeitura — sem chave ' +
      'qualquer um na rede faria o mesmo. Gere uma chave longa e ponha no .env.'
    );
  }
  if (config.chave.length < 32) {
    return 'AGENTE_CHAVE curta demais (mínimo 32 caracteres). Use algo gerado, não digitado.';
  }
  return null;
}

/** Avisos que não impedem de subir, mas precisam aparecer no log. */
export function avisos(): string[] {
  const lista: string[] = [];
  if (config.permitirEscrita) {
    lista.push(
      'PERMITIR_ESCRITA=true — o agente aceita INSERT/UPDATE/DELETE. ' +
        'Só deixe assim se algum sistema realmente precisa gravar.'
    );
  }
  if (config.ipsPermitidos.length === 0) {
    lista.push(
      'IPS_PERMITIDOS vazio — qualquer origem com a chave pode consultar. ' +
        'Numa instalação exposta, liste os IPs dos servidores da Sinsoft.'
    );
  }
  return lista;
}
