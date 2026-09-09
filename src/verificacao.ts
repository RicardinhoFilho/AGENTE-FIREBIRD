import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import type { Banco } from './tipos';

/**
 * Verifica se um `.fbk` realmente restaura.
 *
 * ── Por que isto existe ──────────────────────────────────────────────────────
 * "gbak terminou sem erro" NAO quer dizer "o backup presta". O gbak de backup le
 * registros; ele nao valida a estrutura inteira, e uma base com corrupcao pode
 * gerar um .fbk que so falha no dia em que alguem precisa dele. Nao existe
 * validador offline de .fbk: a unica prova e restaurar.
 *
 * Restaurar reinsere registro por registro e reconstroi todos os indices. Se
 * atravessar isso, o backup presta.
 *
 * ── Cada backup e conferido pela versao dele ─────────────────────────────────
 * O laudo so vale se for sobre o caminho REAL de restauracao. Entao:
 *
 *   base 1.5  -> restaura no Firebird 1.5 que ja existe na maquina do agente
 *                (`localhost:3050`). Versao exata, sem ajuste nenhum.
 *   base 3.0  -> restaura no motor 3.0 EMBUTIDO do pacote, sem servidor.
 *
 * A divisao aproveita o que cada maquina tem: a do agente costuma ter o 1.5
 * instalado e nao ter o 3.0. Assim nenhuma prefeitura precisa instalar nada.
 *
 * Quando falta o servidor 1.5, ha um plano B: restaurar no 3.0 embutido com
 * `-fix_fss_metadata` (a codificacao dos metadados mudou entre as versoes).
 * Isso ainda prova que os dados atravessam a restauracao, mas o laudo sai
 * marcado, porque nao e a versao de destino real.
 *
 * O banco restaurado e descartavel nos dois casos: existe para provar que os
 * dados sobrevivem, nao para virar producao.
 *
 * ── Por que NAO derruba o backup ─────────────────────────────────────────────
 * A verificacao e um SELO, nao um portao. Uma incompatibilidade de metadados
 * 1.5 -> 3.0 pode reprovar um backup perfeitamente bom; se isso impedisse o
 * envio, a prefeitura ficaria sem backup por causa de um falso alarme. Entao o
 * arquivo sobe de qualquer forma e o resultado vai junto, como informacao.
 *
 * ── Modo embutido ────────────────────────────────────────────────────────────
 * Roda sem servidor: o destino e um caminho local, sem `host:`. Para isso o
 * `engine12.dll` precisa estar em `firebird/3.0/plugins/`. O pacote historico
 * do agente traz so o cliente (fbclient e os plugins de autenticacao), porque
 * ate agora ele so LIA bancos remotos. Sem esse arquivo a verificacao e pulada
 * com motivo explicito - nunca tratada como falha do backup.
 */

export interface ResultadoVerificacao {
  /** true = restaurou; false = nao restaurou; null = nao foi possivel verificar. */
  ok: boolean | null;
  /** Sempre preenchido: o que aconteceu, em uma linha. */
  detalhe: string;
  ms?: number;
}

/** O gbak 3.0 que mora dentro do pacote — e o unico que sabe ler os dois formatos. */
function gbakDoPacote(): string {
  return path.join(config.firebirdPasta, '3.0', 'gbak.exe');
}

/** A raiz que o gbak usa para achar `firebird.msg` e a pasta `plugins`. */
function raizDoPacote(): string {
  return path.join(config.firebirdPasta, '3.0');
}

/**
 * O motor embutido esta presente?
 *
 * O nome do arquivo mudou entre versoes do Firebird 3 (engine12/engine13), por
 * isso procuramos por prefixo em vez de fixar um nome.
 */
function acharMotor(): string | null {
  const plugins = path.join(raizDoPacote(), 'plugins');

  try {
    const achado = fs
      .readdirSync(plugins)
      .find((f) => /^engine\d*\.dll$/i.test(f));

    return achado ? path.join(plugins, achado) : null;
  } catch {
    return null;
  }
}

/** Espaco livre no disco onde os temporarios ficam, em bytes. */
function espacoLivre(pasta: string): number | null {
  try {
    // statfsSync existe a partir do Node 18; se faltar, seguimos sem o guarda.
    const st = (fs as any).statfsSync?.(pasta);
    return st ? st.bavail * st.bsize : null;
  } catch {
    return null;
  }
}

/** A base e anterior ao Firebird 3? */
function ehAntiga(versao: string | number | undefined): boolean {
  const numero = parseFloat(String(versao ?? '').replace(',', '.'));
  return !Number.isFinite(numero) || numero < 3;
}

/** O gbak 1.5 que vem no pacote — usado com o servidor 1.5 da propria maquina. */
function gbak15DoPacote(): string {
  return path.join(config.firebirdPasta, '1.5', 'bin', 'gbak.exe');
}

function raiz15DoPacote(): string {
  return path.join(config.firebirdPasta, '1.5');
}

/**
 * Como restaurar, decidido pela versao da base.
 *
 * `hostPrefixo` vazio = motor embutido (caminho local puro). Preenchido = vai
 * pelo servidor, que e o unico jeito no 1.5: ele nao tem motor embutido no
 * pacote, e a maquina do agente ja roda um servidor 1.5.
 */
function escolherMotor(versao: string | number | undefined) {
  if (ehAntiga(versao)) {
    const gbak = gbak15DoPacote();

    if (fs.existsSync(gbak)) {
      return {
        gbak,
        raiz: raiz15DoPacote(),
        senha: config.senhaV15,
        hostPrefixo: `${config.verificar15Host}/${config.verificar15Porta}:`,
        corrigirMetadados: false,
        rotulo: `Firebird 1.5 em ${config.verificar15Host}:${config.verificar15Porta}`,
        exato: true,
      };
    }
  }

  // Base 3.x, ou 1.5 sem o gbak 1.5 no pacote: cai no motor embutido.
  return {
    gbak: gbakDoPacote(),
    raiz: raizDoPacote(),
    senha: config.senhaV3,
    hostPrefixo: '',
    corrigirMetadados: ehAntiga(versao),
    rotulo: 'Firebird 3.0 embutido',
    exato: !ehAntiga(versao),
  };
}

function apagar(caminho: string): void {
  try {
    if (fs.existsSync(caminho)) fs.unlinkSync(caminho);
  } catch {
    /* temporario que nao sai nao vale derrubar nada */
  }
}

/**
 * Restaura o `.fbk` num banco descartavel e apaga em seguida.
 *
 * `aoProgredir` recebe as linhas do gbak, para a tela nao parecer travada: a
 * restauracao de uma base grande passa de dez minutos.
 */
export function verificarBackup(
  fbk: string,
  banco: Banco,
  aoProgredir: (linha: string) => void
): Promise<ResultadoVerificacao> {
  return new Promise((resolver) => {
    const inicio = Date.now();

    if (!config.verificarBackup) {
      return resolver({ ok: null, detalhe: 'Verificacao desligada (VERIFICAR_BACKUP=false).' });
    }

    const motor = escolherMotor(banco.versao);

    if (!fs.existsSync(motor.gbak)) {
      return resolver({ ok: null, detalhe: `Nao verifiquei: nao achei ${motor.gbak}.` });
    }

    // So o modo embutido depende do engine*.dll; pelo servidor 1.5 nao precisa.
    if (!motor.hostPrefixo && !acharMotor()) {
      return resolver({
        ok: null,
        detalhe:
          'Nao verifiquei: falta o motor embutido (engine*.dll) em ' +
          path.join(raizDoPacote(), 'plugins') +
          '. Copie-o, junto do icudt*.dat, da instalacao do Firebird 3.0.',
      });
    }

    let bytesFbk = 0;
    try {
      bytesFbk = fs.statSync(fbk).size;
    } catch {
      return resolver({ ok: null, detalhe: 'Nao verifiquei: o .fbk sumiu antes da conferencia.' });
    }

    const limite = config.verificarMaxGb * 1024 * 1024 * 1024;
    if (limite > 0 && bytesFbk > limite) {
      return resolver({
        ok: null,
        detalhe:
          `Nao verifiquei: backup de ${(bytesFbk / 1073741824).toFixed(1)} GB passa do teto de ` +
          `${config.verificarMaxGb} GB (VERIFICAR_MAX_GB). Restaurar aqui encheria o disco.`,
      });
    }

    // O banco restaurado costuma passar do dobro do .fbk. Pedimos 3x de folga:
    // encher o disco da prefeitura para conferir um backup seria o remedio pior
    // que a doenca.
    const livre = espacoLivre(config.backupPasta);
    if (livre != null && livre < bytesFbk * 3) {
      return resolver({
        ok: null,
        detalhe:
          `Nao verifiquei: ${(livre / 1073741824).toFixed(1)} GB livres nao bastam para restaurar ` +
          `um .fbk de ${(bytesFbk / 1048576).toFixed(0)} MB (preciso de ~3x).`,
      });
    }

    const destino = path.join(config.backupPasta, `verificacao-${Date.now()}.fdb`);

    const argumentos = ['-c'];
    if (motor.corrigirMetadados) {
      // A codificacao dos metadados mudou do 1.5 para o 3.0; sem isto o gbak
      // para com "Invalid metadata detected" numa base perfeitamente boa.
      argumentos.push('-fix_fss_metadata', 'WIN1252');
    }
    argumentos.push(
      '-v',
      '-user',
      'SYSDBA',
      '-password',
      motor.senha,
      fbk,
      `${motor.hostPrefixo}${destino}`
    );

    const processo = spawn(motor.gbak, argumentos, {
      windowsHide: true,
      env: {
        ...process.env,
        // Sem FIREBIRD apontando para a raiz do pacote, o gbak nao acha o
        // firebird.msg e devolve numero de erro em vez de texto - e o texto e
        // exatamente o que precisamos guardar quando algo falha.
        FIREBIRD: motor.raiz,
      },
    });

    let saida = '';
    const juntar = (pedaco: Buffer) => {
      const texto = pedaco.toString();
      saida += texto;
      // O gbak -v cospe uma linha por tabela; mandamos a ultima para o registro.
      const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
      if (linhas.length) aoProgredir(linhas[linhas.length - 1]);
    };

    processo.stdout.on('data', juntar);
    processo.stderr.on('data', juntar);

    const relogio = setTimeout(() => {
      processo.kill();
    }, config.verificarTimeoutMs);

    const terminar = (resultado: ResultadoVerificacao) => {
      clearTimeout(relogio);
      apagar(destino);
      resolver({ ...resultado, ms: Date.now() - inicio });
    };

    processo.on('error', (e) =>
      terminar({ ok: null, detalhe: `Nao verifiquei: nao consegui executar o gbak (${e.message}).` })
    );

    processo.on('close', (codigo) => {
      if (codigo === 0) {
        let bytes = 0;
        try {
          bytes = fs.statSync(destino).size;
        } catch {
          /* o tamanho e so informativo */
        }

        const onde = motor.exato
          ? motor.rotulo
          : `${motor.rotulo} - versao diferente da origem, laudo com ressalva`;

        return terminar({
          ok: true,
          detalhe:
            (bytes
              ? `Restaurou ${(bytes / 1048576).toFixed(0)} MB`
              : 'Restaurou sem erros') + ` no ${onde}.`,
        });
      }

      // Guardamos o texto do gbak inteiro no log e um resumo no registro: e ele
      // que diz se foi corrupcao de dados ou incompatibilidade de metadados.
      const motivo = saida.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
      terminar({
        ok: false,
        detalhe:
          `NAO restaurou no ${motor.rotulo} (gbak codigo ${codigo}): ` +
          (motivo || '(sem saida)'),
      });
    });
  });
}
