/**
 * Carimba a hora local em cada linha do console.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 * O agente roda como servico e o NSSM joga a saida em `C:\Sinsoft\agente.log`.
 * Sem hora, esse arquivo responde "o que aconteceu" mas nunca "quando" — e a
 * pergunta que o suporte faz e sempre a segunda. Ja aconteceu de olhar o log
 * depois de copiar um arquivo que faltava e nao dar para saber se as linhas de
 * erro eram de antes ou de depois: so comparando id de backup na mao.
 *
 * ── Por que trocar o console em vez de arrumar cada chamada ─────────────────
 * Sao dezenas de `console.log` espalhados, e qualquer um novo esqueceria o
 * carimbo. Trocando aqui, uma vez, TODA linha sai carimbada — inclusive as de
 * biblioteca de terceiro.
 *
 * ── Hora local, nao UTC ─────────────────────────────────────────────────────
 * Quem le o log esta na prefeitura e compara com o relogio da parede. O mesmo
 * motivo que fez o carimbo do nome do arquivo virar local.
 */

function agora(): string {
  const d = new Date();
  const dois = (n: number) => String(n).padStart(2, '0');

  return (
    `${dois(d.getDate())}/${dois(d.getMonth() + 1)} ` +
    `${dois(d.getHours())}:${dois(d.getMinutes())}:${dois(d.getSeconds())}`
  );
}

/** Chame uma vez, o mais cedo possivel na subida. */
export function carimbarConsole(): void {
  const originais = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const carimbar =
    (escrever: (...args: unknown[]) => void) =>
    (...args: unknown[]) =>
      escrever(`[${agora()}]`, ...args);

  console.log = carimbar(originais.log);
  console.warn = carimbar(originais.warn);
  console.error = carimbar(originais.error);
}

// Aplicado no proprio carregamento do modulo. E o unico jeito de garantir a
// ordem: em CommonJS todos os `import` do arquivo sao resolvidos antes de
// qualquer linha de codigo dele, entao chamar isto no server.ts rodaria
// DEPOIS dos outros modulos - e as mensagens de subida deles sairiam sem hora.
carimbarConsole();
