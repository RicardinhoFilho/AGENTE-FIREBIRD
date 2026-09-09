import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import archiver from 'archiver';
import { Client as ClienteFtp } from 'basic-ftp';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { senhaDe, usuarioDe } from './pool';
import type { Backup, Banco } from './tipos';
import { verificarBackup } from './verificacao';

/**
 * Backup da base para o FTP da Sinsoft.
 *
 * Quatro etapas: `gbak` gera o .fbk, a restauracao confere se ele presta, o
 * .fbk vira .zip e o .zip sobe. Roda em
 * segundo plano porque base de prefeitura tem varios GB — so o gbak ja passa de
 * meia hora, e nenhuma requisicao HTTP sobrevive a isso. Quem chama recebe um
 * `id` na hora e pergunta o estado depois.
 */

/** Os backups desta execucao. Some quando o servico reinicia — e so estado. */
const backups = new Map<string, Backup>();

/**
 * Um backup por vez.
 *
 * Dois gbak simultaneos na mesma maquina disputam disco e rede da prefeitura, e
 * dobram o espaco temporario necessario. Nao vale o risco: o segundo pedido
 * recebe 409 e tenta de novo depois.
 */
let emAndamento: string | null = null;

export function backupEmAndamento(): string | null {
  return emAndamento;
}

export function obterBackup(id: string): Backup | undefined {
  return backups.get(id);
}

export function listarBackups(): Backup[] {
  return [...backups.values()].sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}

/**
 * Onde procurar o gbak para uma `versao`, na ordem.
 *
 * Primeiro a subpasta com o nome EXATO da versao pedida — `firebird\5.0` para
 * `"versao": "5.0"`. Isso e o que permite atender uma versao nova sem tocar no
 * codigo: basta largar a pasta do cliente ao lado do exe. Sem isso, qualquer
 * base 4.x ou 5.x cairia no gbak do 3.0, que nao fala o protocolo dela.
 *
 * Depois vem a lista fixa, que so distingue "3 ou mais" de "menos que 3".
 */
function caminhosDeGbak(versao: string | number | undefined): string[] {
  const pedida = String(versao ?? '').trim();
  const candidatos: string[] = [];

  if (/^\d+(\.\d+)?$/.test(pedida)) {
    candidatos.push(path.join(config.firebirdPasta, pedida, 'gbak.exe'));
    candidatos.push(path.join(config.firebirdPasta, pedida, 'bin', 'gbak.exe'));
  }

  const maior = Number(pedida.match(/(\d+)/)?.[1]);
  candidatos.push(...(maior >= 3 ? config.gbakV3 : config.gbakV15));
  return candidatos;
}

/** O primeiro gbak.exe que existir no disco, na versao que casa com a base. */
function acharGbak(versao: string | number | undefined): string | null {
  return caminhosDeGbak(versao).find(c => fs.existsSync(c)) ?? null;
}

/**
 * Como o gbak enxerga o banco.
 *
 * `host:caminho` (ou `host/porta:caminho` fora da 3050) faz ele conectar como
 * cliente e escrever o .fbk AQUI, na maquina do agente — e por isso que o banco
 * pode estar numa VM: nao e preciso alcancar o disco dela, so o servico.
 */
function destinoGbak(banco: Banco): string {
  /**
   * A porta vai SEMPRE explicita, mesmo sendo a 3050.
   *
   * Omitida, quem decide passa a ser o `RemoteServicePort` do firebird.conf que
   * o cliente encontrar — e um arquivo herdado de instalacao servidor ja fez o
   * gbak discar 3051 em toda prefeitura, falhando como se fosse erro de rede.
   * Na string de conexao, nenhuma configuracao de terceiro tem como interferir.
   */
  const porta = Number(banco.porta) || 3050;
  return `${banco.host}/${porta}:${banco.caminho}`;
}

/**
 * O municipio vira PASTA no FTP, entao entra aqui como texto hostil.
 *
 * Um `../..` no nome escreveria fora de `agente_firebird/` — em qualquer lugar
 * onde o usuario do FTP tenha permissao. So sobra letra, numero e hifen; acento
 * perde o sinal (BARRACAO, nao BARRAC%C3%83O) e o resto vira `_`. Ponto nao
 * passa, o que fecha a porta do `..` de vez.
 */
export function pastaSegura(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function nomeDaBase(banco: Banco): string {
  return path.basename(banco.caminho).replace(/\.[^.]+$/, '') || 'banco';
}

function carimbo(): string {
  /**
   * HORA LOCAL, nao UTC.
   *
   * `toISOString()` dava UTC, e no Brasil (UTC-3) todo backup rodado depois
   * das 21h saia carimbado com o dia SEGUINTE. A checagem do dia certo
   * acusava falta e o dia seguinte mostrava um backup que nao foi feito nele
   * - os dois dias mentindo. Aconteceu em producao: o arquivo
   * SIAFIC2025_20260909-000057.zip foi gerado as 21h00 do dia 08.
   *
   * O dia de um backup e um conceito da prefeitura, e quem escolhe a data na
   * tela tambem pensa em horario local. Nada na cadeia depende de ser UTC: a
   * checagem so le o que esta escrito no nome.
   */
  const d = new Date();
  const dois = (n: number) => String(n).padStart(2, '0');

  const dia = `${d.getFullYear()}${dois(d.getMonth() + 1)}${dois(d.getDate())}`;
  const hora = `${dois(d.getHours())}${dois(d.getMinutes())}${dois(d.getSeconds())}`;

  return `${dia}-${hora}`;
}

/**
 * A raiz da instalacao Firebird a que aquele gbak pertence.
 *
 * No Firebird 3 o gbak fica na propria raiz; no 1.5 e 2.5, dentro de `bin\`. E
 * a raiz que guarda o `firebird.msg`.
 */
function raizFirebird(gbak: string): string {
  const pasta = path.dirname(gbak);
  return path.basename(pasta).toLowerCase() === 'bin' ? path.dirname(pasta) : pasta;
}

/**
 * Um aviso a cada `intervalo`, no maximo.
 *
 * O `gbak -v` cospe uma linha por tabela e a cada lote de registros: numa base
 * de prefeitura sao milhares. Escrever todas no `agente.log` transformaria o
 * arquivo num monstro e ainda esconderia o que importa. Uma a cada poucos
 * segundos ja mostra que a coisa anda.
 */
function aCadaTanto(intervalo: number): (escrever: () => void) => void {
  let ultimo = 0;
  return escrever => {
    const agora = Date.now();
    if (agora - ultimo < intervalo) return;
    ultimo = agora;
    escrever();
  };
}

/** Roda o gbak e espera. Rejeita com o que ele escreveu, que e onde vem o motivo. */
function rodarGbak(
  gbak: string,
  banco: Banco,
  destino: string,
  aoAndar: (linha: string) => void
): Promise<void> {
  return new Promise((resolver, rejeitar) => {
    const argumentos = [
      '-b',            // backup
      '-v',            // conta o que esta fazendo, tabela por tabela
      '-g',            // sem garbage collection: mais rapido e nao mexe na base
      '-limbo',        // nao trava por causa de transacao em duvida
      destinoGbak(banco),
      destino,
    ];

    /**
     * Credencial pelo ambiente, nao pela linha de comando.
     *
     * `-password` apareceria na lista de processos do Windows para qualquer um
     * logado na maquina. `ISC_USER`/`ISC_PASSWORD` o gbak le sozinho.
     *
     * `FIREBIRD` aponta a raiz onde mora o `firebird.msg`. Sem ela, um gbak
     * avulso (a copia que anda junto do exe, fora de uma instalacao) nao acha o
     * arquivo de mensagens e reporta "Firebird error code 335544721" no lugar
     * do texto — foi justamente o texto do gbak que apontou o problema da VM.
     */
    const processo = spawn(gbak, argumentos, {
      env: {
        ...process.env,
        FIREBIRD: raizFirebird(gbak),
        ISC_USER: usuarioDe(banco),
        ISC_PASSWORD: senhaDe(banco),
      },
      windowsHide: true,
    });

    /**
     * Guarda so o fim da saida.
     *
     * Com `-v` numa base grande sao megabytes de texto, e o que interessa
     * quando da erro esta sempre nas ultimas linhas. Sem o corte, uma base de
     * 10 GB inflaria a memoria do agente a troco de nada.
     */
    let saida = '';
    let sobra = '';
    const engolir = (pedaco: string) => {
      saida = (saida + pedaco).slice(-8192);

      // A ultima linha de um `data` costuma vir partida; guarda para a proxima.
      const linhas = (sobra + pedaco).split(/\r?\n/);
      sobra = linhas.pop() ?? '';
      for (const linha of linhas) {
        const limpa = linha.trim();
        if (limpa) aoAndar(limpa);
      }
    };

    processo.stdout.on('data', d => engolir(String(d)));
    processo.stderr.on('data', d => engolir(String(d)));

    const relogio = setTimeout(() => {
      processo.kill();
      rejeitar(new Error(`gbak passou de ${config.backupTimeoutMs}ms e foi interrompido`));
    }, config.backupTimeoutMs);

    processo.on('error', e => {
      clearTimeout(relogio);
      rejeitar(new Error(`nao consegui executar ${gbak}: ${e.message}`));
    });

    processo.on('close', codigo => {
      clearTimeout(relogio);
      if (codigo === 0) return resolver();
      rejeitar(new Error(`gbak terminou com codigo ${codigo}: ${saida.trim() || '(sem saida)'}`));
    });
  });
}

/** Compacta em streaming — o .fbk nunca passa inteiro pela memoria. */
function compactar(origem: string, destino: string, nomeInterno: string): Promise<void> {
  return new Promise((resolver, rejeitar) => {
    const arquivo = fs.createWriteStream(destino);
    const zip = archiver('zip', { zlib: { level: 6 } });

    arquivo.on('close', () => resolver());
    arquivo.on('error', rejeitar);
    zip.on('error', rejeitar);

    zip.pipe(arquivo);
    zip.file(origem, { name: nomeInterno });
    void zip.finalize();
  });
}

/**
 * Sobe com nome provisorio e so renomeia no fim.
 *
 * Link de prefeitura cai, e um upload interrompido deixaria um .zip truncado
 * **com o nome definitivo** — quem conferisse o FTP pelo nome concluiria que o
 * backup existe, e so descobriria o contrario no dia de restaurar. Com o
 * `.parcial`, o nome final so aparece depois que o arquivo chegou inteiro:
 * existir passa a significar estar completo.
 */
async function enviarPorFtp(
  local: string,
  municipio: string,
  nomeRemoto: string,
  aoAndar: (bytes: number) => void
): Promise<number | null> {
  const cliente = new ClienteFtp(60000);
  const provisorio = `${nomeRemoto}.parcial`;
  cliente.trackProgress(info => aoAndar(info.bytes));
  try {
    await cliente.access({
      host: config.ftp.host,
      user: config.ftp.usuario,
      password: config.ftp.senha,
      secure: config.ftp.seguro,
    });
    // Cria `agente_firebird/<MUNICIPIO>` (os dois niveis, se faltarem) e entra.
    await cliente.ensureDir(`${config.ftp.pasta}/${municipio}`);
    await cliente.uploadFrom(local, provisorio);
    await cliente.rename(provisorio, nomeRemoto);

    // Pergunta ao servidor quantos bytes ele guardou. E a confirmacao mais
    // barata de que o arquivo chegou inteiro - e nem todo servidor FTP responde
    // ao SIZE, entao a ausencia de resposta nao vira acusacao.
    try {
      return await cliente.size(nomeRemoto);
    } catch {
      return null;
    }
  } catch (e) {
    // Melhor esforco: se a conexao ainda responder, nao deixa lixo para tras.
    // Se ela e que caiu, o .parcial fica — e o nome ja diz o que ele e.
    try {
      await cliente.remove(provisorio);
    } catch {
      /* conexao ja foi embora; nada a fazer daqui */
    }
    throw e;
  } finally {
    cliente.close();
  }
}

/**
 * SHA-256 do arquivo, lido em fluxo.
 *
 * Em fluxo porque o zip passa de centenas de MB: ler tudo para a memoria numa
 * maquina de prefeitura e pedir para o backup morrer por falta de RAM.
 */
function hashDoArquivo(caminho: string): Promise<string> {
  return new Promise((resolver, rejeitar) => {
    const hash = createHash('sha256');
    const leitura = fs.createReadStream(caminho);

    leitura.on('error', rejeitar);
    leitura.on('data', pedaco => hash.update(pedaco));
    leitura.on('end', () => resolver(hash.digest('hex')));
  });
}

/** Apaga o temporario sem derrubar o backup se a remocao falhar. */
function apagar(caminho: string): void {
  try {
    if (fs.existsSync(caminho)) fs.unlinkSync(caminho);
  } catch (e) {
    console.warn(`[backup] nao consegui apagar ${caminho}: ${(e as Error).message}`);
  }
}

/**
 * Dispara o backup e devolve o registro na hora, ainda em `gerando`.
 *
 * Lanca so o que da para saber antes de comecar (gbak inexistente, outro backup
 * rodando). O resto do caminho reporta pelo estado, nao por excecao — quem
 * chamou ja recebeu a resposta ha muito tempo.
 */
export function iniciarBackup(banco: Banco, municipio: string, nomeEscolhido?: string): Backup {
  if (emAndamento) {
    throw new Error(`Ja existe um backup em andamento (id ${emAndamento}). Espere ele terminar.`);
  }

  const pasta = pastaSegura(municipio);
  if (!pasta) {
    throw new Error(
      `\`municipio\` "${municipio}" nao sobrou nada depois de higienizado. ` +
        'Use letras e numeros, por exemplo "HERVEIRAS".'
    );
  }

  const gbak = acharGbak(banco.versao);
  if (!gbak) {
    throw new Error(
      `gbak.exe nao encontrado para a versao ${banco.versao ?? '(nao informada)'}. ` +
        `Procurei em: ${caminhosDeGbak(banco.versao).join(', ')}. Copie o cliente ` +
        `Firebird dessa versao para ${path.join(config.firebirdPasta, String(banco.versao ?? 'X.Y'))}.`
    );
  }

  const id = randomUUID();
  const base = nomeEscolhido?.trim() || nomeDaBase(banco);
  const registro: Backup = {
    id,
    estado: 'gerando',
    municipio: pasta,
    banco: `${banco.host}:${banco.caminho}`,
    criadoEm: new Date().toISOString(),
  };
  backups.set(id, registro);
  emAndamento = id;

  void processar(registro, banco, base, gbak);
  return registro;
}

async function processar(registro: Backup, banco: Banco, base: string, gbak: string): Promise<void> {
  const inicio = Date.now();
  const nomeArquivo = `${base}_${carimbo()}`;
  const fbk = path.join(config.backupPasta, `${nomeArquivo}.fbk`);
  const zip = path.join(config.backupPasta, `${nomeArquivo}.zip`);

  try {
    fs.mkdirSync(config.backupPasta, { recursive: true });

    // O caminho do gbak vai no log de proposito: quando a base recusa o backup
    // por versao, saber QUAL binario rodou e a primeira pergunta.
    console.log(`[backup ${registro.id}] ${gbak}`);
    console.log(`[backup ${registro.id}] gbak ${destinoGbak(banco)} -> ${fbk}`);
    const avisar = aCadaTanto(5000);
    await rodarGbak(gbak, banco, fbk, linha => {
      registro.progresso = linha;
      avisar(() => console.log(`[backup ${registro.id}] ${linha}`));
    });
    registro.bytesFbk = fs.statSync(fbk).size;

    // ── Confere restaurando ────────────────────────────────────────────────
    // Nao interrompe o fluxo em nenhuma hipotese: o resultado e informacao
    // colada no registro. Ver a explicacao em verificacao.ts.
    registro.estado = 'verificando';
    console.log(`[backup ${registro.id}] verificando: restaurando o .fbk num banco descartavel`);
    const avisarVerif = aCadaTanto(5000);
    const conferencia = await verificarBackup(fbk, banco, linha => {
      registro.progresso = `verificando: ${linha}`;
      avisarVerif(() => console.log(`[backup ${registro.id}] ${registro.progresso}`));
    });
    registro.verificado = conferencia.ok;
    registro.verificacao = conferencia.detalhe;
    console.log(
      `[backup ${registro.id}] verificacao: ${conferencia.detalhe}` +
        (conferencia.ms ? ` (${Math.round(conferencia.ms / 1000)}s)` : '')
    );

    registro.estado = 'compactando';
    console.log(`[backup ${registro.id}] compactando ${registro.bytesFbk} bytes`);
    await compactar(fbk, zip, `${nomeArquivo}.fbk`);
    registro.bytesZip = fs.statSync(zip).size;
    // O .fbk ja cumpriu o papel; segurar os dois dobra o espaco ocupado.
    apagar(fbk);

    // O hash sai ANTES do envio: e ele que liga o arquivo verificado ao
    // arquivo que vai parar no FTP.
    registro.sha256 = await hashDoArquivo(zip);
    console.log(`[backup ${registro.id}] sha256 ${registro.sha256}`);

    registro.estado = 'enviando';
    registro.arquivo = `${nomeArquivo}.zip`;
    console.log(`[backup ${registro.id}] enviando ${registro.bytesZip} bytes para o FTP`);
    const avisarEnvio = aCadaTanto(5000);
    const bytesRemotos = await enviarPorFtp(zip, registro.municipio, registro.arquivo, bytes => {
      const total = registro.bytesZip ?? 0;
      const pct = total ? Math.floor((bytes / total) * 100) : 0;
      registro.progresso = `enviado ${bytes} de ${total} bytes (${pct}%)`;
      avisarEnvio(() => console.log(`[backup ${registro.id}] ${registro.progresso}`));
    });

    registro.envioConferido =
      bytesRemotos == null ? null : bytesRemotos === registro.bytesZip;

    if (registro.envioConferido === false) {
      // Chegou diferente do que saiu: o arquivo esta la, mas truncado. Melhor
      // gritar agora do que descobrir no dia da restauracao.
      throw new Error(
        `Upload incompleto: enviei ${registro.bytesZip} bytes e o FTP guardou ${bytesRemotos}.`
      );
    }

    registro.estado = 'pronto';
    console.log(
      `[backup ${registro.id}] pronto: ${config.ftp.pasta}/${registro.municipio}/${registro.arquivo}` +
        (registro.envioConferido ? ' (tamanho conferido no servidor)' : '')
    );
  } catch (e) {
    registro.estado = 'erro';
    registro.erro = e instanceof Error ? e.message : 'Falha no backup';
    console.error(`[backup ${registro.id}] ERRO: ${registro.erro}`);
  } finally {
    // Os temporarios saem deu certo ou nao: o disco da prefeitura nao e deposito.
    apagar(fbk);
    apagar(zip);
    registro.terminadoEm = new Date().toISOString();
    registro.ms = Date.now() - inicio;
    emAndamento = null;
  }
}
