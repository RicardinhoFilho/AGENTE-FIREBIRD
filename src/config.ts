import os from 'os';
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
const PERMITIR_DDL_PADRAO = true;       // CREATE/ALTER/DROP... (migracoes). false = mais seguro
const PERMITIR_BACKUP_PADRAO = true;    // rota /backup (gbak + zip + FTP). false = desliga

/**
 * Destino do backup.
 *
 * Fica AQUI, e nao no corpo da requisicao, de proposito: se quem chama pudesse
 * escolher o destino, a rota viraria uma ferramenta de exfiltracao — com a
 * chave em maos, qualquer um mandaria a base da prefeitura para o proprio
 * servidor. Assim o agente so sabe subir para um lugar: este.
 *
 * >>> A SENHA FICA COMPILADA NO EXE, que roda em toda prefeitura. Quem tiver
 * acesso a uma dessas maquinas consegue le-la de dentro do binario. Use uma
 * conta de FTP so de escrita, sem permissao de listar nem baixar. <<<
 */
const FTP_PADRAO = {
  host: 'bkp.sinsoft.com.br',
  usuario: 'ftpsinsoft',
  senha: 'OZ3msYLsLZiuI',
  pasta: 'agente_firebird',
};

/**
 * Onde procurar o `gbak.exe`, na ordem, por versao do Firebird.
 *
 * O backup NAO pode ser copia do .GDB: com o servidor rodando, o arquivo tem
 * paginas ainda em memoria e transacoes abertas, e a copia sai inconsistente —
 * o pior tipo de defeito, porque so aparece no dia da restauracao. O `gbak` le
 * pelo proprio servidor e sai consistente, com o banco no ar.
 *
 * O binario tem que ser o da MESMA versao do servidor: o gbak do 3.0 nao le
 * base 1.5. No Firebird 3 ele fica na raiz da instalacao; no 1.5 e 2.5, em bin\.
 */
const GBAK_V3_PADRAO = [
  // Primeiro a copia que anda junto do exe: e a unica que voce controla. Boa
  // parte das prefeituras nao tem Firebird instalado na maquina do agente — o
  // banco mora noutro servidor —, e sem isso a rota de backup nao existiria la.
  path.join(pastaDoEnv, 'firebird', '3.0', 'gbak.exe'),
  path.join(pastaDoEnv, 'firebird', '3.0', 'bin', 'gbak.exe'),
  'C:\\Program Files\\Firebird\\Firebird_3_0\\gbak.exe',
  'C:\\Program Files\\Firebird\\Firebird_3_0\\bin\\gbak.exe',
  'C:\\Program Files (x86)\\Firebird\\Firebird_3_0\\gbak.exe',
  'C:\\Firebird\\Firebird_3_0\\gbak.exe',
];
const GBAK_V15_PADRAO = [
  path.join(pastaDoEnv, 'firebird', '1.5', 'bin', 'gbak.exe'),
  path.join(pastaDoEnv, 'firebird', '1.5', 'gbak.exe'),
  'C:\\Program Files\\Firebird\\Firebird_1_5\\bin\\gbak.exe',
  'C:\\Program Files (x86)\\Firebird\\Firebird_1_5\\bin\\gbak.exe',
  'C:\\Program Files\\Firebird\\Firebird_2_5\\bin\\gbak.exe',
  'C:\\Firebird\\Firebird_1_5\\bin\\gbak.exe',
];

/** Mostrado no log, para quem instala saber qual arquivo o agente leu. */
export const caminhoDoEnv = path.join(pastaDoEnv, '.env');

function booleano(nome: string, padrao: boolean): boolean {
  const valor = process.env[nome];
  if (valor === undefined || valor === '') return padrao;
  return valor.toLowerCase() === 'true' || valor === '1';
}

/**
 * Quem pode chamar o agente.
 *
 * `IPS_PERMITIDOS=*` desliga o filtro por completo — inclusive os IPS_FIXOS
 * compilados, que de outro modo entrariam sempre e manteriam a lista nao vazia.
 * Serve para as instalacoes onde o filtro ja nao filtra nada: onde a borda faz
 * SNAT, TODA chamada chega com o mesmo endereco, entao listar IP e teatro.
 *
 * Desligado, o que segura o acesso e so a chave. Prefira travar no firewall da
 * prefeitura, que e a unica camada que ainda enxerga a origem verdadeira.
 */
function listaDeIps(): string[] {
  const doEnv = lista('IPS_PERMITIDOS');
  if (doEnv.includes('*')) return [];
  return [...new Set([...IPS_FIXOS, ...doEnv])];
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
  ipsPermitidos: listaDeIps(),

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

  /**
   * Deixa passar comandos de ESTRUTURA (DDL): CREATE/ALTER/DROP/TRUNCATE/...
   * Necessario para migracoes. Fica separado do PERMITIR_ESCRITA porque e mais
   * perigoso — um DROP nao tem desfazer. A lista de IPs + a chave e que seguram.
   */
  permitirDdl: booleano('PERMITIR_DDL', PERMITIR_DDL_PADRAO),

  /** Corta a consulta que passar disto. Protege memória e o link da prefeitura. */
  maxLinhas: Number(process.env.MAX_LINHAS ?? 200000),

  /** Tempo máximo de uma consulta. */
  timeoutMs: Number(process.env.TIMEOUT_MS ?? 120000),

  /** Quantas conexões por banco. */
  tamanhoPool: Number(process.env.TAMANHO_POOL ?? 5),

  /**
   * Teto para OBTER uma conexao do pool (handshake + espera na fila).
   *
   * Curto de proposito, para que um Firebird morto nao pendure a requisicao por
   * minutos. Mas um lote grande num banco lento faz as consultas excedentes
   * esperarem na fila e estourarem aqui — nesse caso o remedio e aumentar o
   * TAMANHO_POOL, nao este numero.
   */
  timeoutConexaoMs: Number(process.env.TIMEOUT_CONEXAO_MS ?? 20000),

  /**
   * Senha do SYSDBA por versão do Firebird — a mesma regra dos outros sistemas
   * da casa: 1.5 → masterkey, 3.x → SIN_S1_S2.
   */
  senhaV3: process.env.FB_SENHA_V3 ?? 'SIN_S1_S2',
  senhaV15: process.env.FB_SENHA_V15 ?? 'masterkey',

  /** Liga a rota /backup. Desligada, ela responde 403 e nada roda. */
  permitirBackup: booleano('PERMITIR_BACKUP', PERMITIR_BACKUP_PADRAO),

  ftp: {
    host: process.env.FTP_HOST ?? FTP_PADRAO.host,
    usuario: process.env.FTP_USUARIO ?? FTP_PADRAO.usuario,
    senha: process.env.FTP_SENHA ?? FTP_PADRAO.senha,
    pasta: process.env.FTP_PASTA ?? FTP_PADRAO.pasta,
    /** FTPS explicito. O servidor precisa suportar; por isso nao e o padrao. */
    seguro: booleano('FTP_SEGURO', false),
  },

  /**
   * Pasta das copias portateis do cliente Firebird, uma subpasta por versao:
   * `firebird\1.5`, `firebird\3.0`, `firebird\5.0`... O nome da subpasta e
   * exatamente o que vem em `banco.versao`, entao dar suporte a uma versao
   * nova e so largar a pasta ali — sem recompilar o agente.
   */
  firebirdPasta: process.env.FIREBIRD_PASTA ?? path.join(pastaDoEnv, 'firebird'),

  /** Candidatos a gbak.exe. O primeiro que existir no disco e o usado. */
  gbakV3: lista('GBAK_V3').concat(GBAK_V3_PADRAO),
  gbakV15: lista('GBAK_V15').concat(GBAK_V15_PADRAO),

  /**
   * Onde o .fbk e o .zip nascem antes de subir.
   *
   * Vai para o TEMP do sistema por padrao, nao para a pasta do exe: o .fbk pode
   * ter o tamanho do banco, e encher o disco onde o agente roda e um estrago
   * bem pior que um backup que falhou. Os dois sao apagados no fim, deu certo
   * ou nao.
   */
  backupPasta: process.env.BACKUP_PASTA ?? path.join(os.tmpdir(), 'agente-backup'),

  /** Teto de um backup inteiro (gbak + zip + upload). Base grande demora. */
  backupTimeoutMs: Number(process.env.BACKUP_TIMEOUT_MS ?? 7200000),

  /**
   * Conferir o backup restaurando-o num banco descartavel.
   *
   * "gbak terminou sem erro" nao prova que o .fbk restaura. Restaurar prova - e
   * e a unica coisa que prova. Custa o dobro do tempo e ~3x o espaco em disco,
   * entao vem com teto e pode ser desligado numa prefeitura apertada.
   */
  verificarBackup: booleano('VERIFICAR_BACKUP', true),

  /** Acima disto o backup nao e conferido, para nao encher o disco da prefeitura. */
  verificarMaxGb: Number(process.env.VERIFICAR_MAX_GB ?? 5),

  /** Teto de tempo da conferencia. Restaurar 400 MB levou ~3 min nos testes. */
  verificarTimeoutMs: Number(process.env.VERIFICAR_TIMEOUT_MS ?? 3600000),

  /**
   * Servidor Firebird 1.5 usado para conferir backups de base 1.5.
   *
   * A maquina do agente quase sempre TEM Firebird 1.5 instalado (e nao tem o
   * 3.0). Usar o servidor que ja esta ali confere o backup com a versao exata
   * dele - que e o caminho real de restauracao numa prefeitura -, em vez de
   * restaurar no 3.0 com correcao de metadados.
   *
   * Sem esse servidor a conferencia das bases 1.5 e pulada com motivo, nunca
   * tratada como backup reprovado.
   */
  verificar15Host: process.env.VERIFICAR_15_HOST ?? 'localhost',
  verificar15Porta: Number(process.env.VERIFICAR_15_PORTA ?? 3050),
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
  if (config.permitirDdl) {
    lista.push(
      'PERMITIR_DDL=true — o agente aceita CREATE/ALTER/DROP/TRUNCATE (mudam a ' +
        'estrutura do banco). Use para migracoes; um DROP nao tem desfazer.'
    );
  }
  if (config.permitirBackup) {
    lista.push(
      `PERMITIR_BACKUP=true — a rota /backup manda a base para o FTP ` +
        `${config.ftp.host}/${config.ftp.pasta}. Desligue onde nao for usada.`
    );
  }
  if (config.ipsPermitidos.length === 0) {
    lista.push(
      'FILTRO DE IP DESLIGADO — qualquer origem com a chave pode consultar e ' +
        'executar backup. A chave e a unica protecao. Trave a porta no firewall ' +
        'da prefeitura, que ainda enxerga o IP de origem verdadeiro.'
    );
  }
  return lista;
}
