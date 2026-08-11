import { timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { config } from './config';

/**
 * Compara a chave sem vazar o tamanho pelo tempo de resposta.
 *
 * Um `===` sai no primeiro caractere diferente, e a diferença de tempo entre
 * "errou no 1º" e "errou no 20º" é medível pela rede. Aqui as duas cadeias são
 * sempre percorridas inteiras.
 */
function chaveConfere(recebida: string): boolean {
  const a = Buffer.from(recebida);
  const b = Buffer.from(config.chave);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Bloqueia qualquer IP fora da lista. Aplicado GLOBALMENTE (antes de todas as
 * rotas), entao vale ate para /saude e /health: nada responde a quem nao vem de
 * um IP autorizado.
 */
export function filtrarIp(req: Request, res: Response, next: NextFunction): void {
  if (config.ipsPermitidos.length > 0) {
    const origem = (req.ip ?? '').replace(/^::ffff:/, '');
    if (!config.ipsPermitidos.includes(origem)) {
      console.warn(`[bloqueado] IP ${origem} não está em IPS_PERMITIDOS`);
      res.status(403).json({ ok: false, erro: 'Origem não autorizada' });
      return;
    }
  }
  next();
}

/** Exige a chave. O IP ja foi filtrado antes, globalmente (filtrarIp). */
export function autenticar(req: Request, res: Response, next: NextFunction): void {
  const cabecalho = req.headers.authorization ?? '';
  const chave = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : '';

  if (!chave || !chaveConfere(chave)) {
    res.status(401).json({ ok: false, erro: 'Chave ausente ou inválida' });
    return;
  }

  next();
}

/**
 * Tira comentários do SQL antes de olhar para ele.
 *
 * Sem isso, um comentário de bloco ou de linha antes do comando passaria pela
 * checagem de "começa com SELECT" — e o DELETE viria logo atrás.
 */
function semComentarios(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .trim();
}

/**
 * O que o agente aceita executar.
 *
 * Por padrão, **só leitura**: qualquer coisa que não comece com SELECT, WITH ou
 * EXECUTE BLOCK é recusada. Vale a pena mesmo com a chave no meio — o agente
 * roda dentro da prefeitura, e uma chave que vaze não pode virar um `DELETE FROM
 * ANUAL`. Quem precisa gravar liga `PERMITIR_ESCRITA` e assume o risco.
 *
 * Também recusa **mais de um comando na mesma string**: o driver só executa o
 * primeiro, mas aceitar `;` é o convite clássico para SQL injection do outro
 * lado — se quem chama montar SQL concatenando texto de usuário, é aqui que a
 * emenda apareceria.
 */
export function validarSql(sql: string): string | null {
  const limpo = semComentarios(sql);

  if (!limpo) return 'SQL vazio';

  // ponto e vírgula só é problema quando há comando depois dele
  const semFinal = limpo.replace(/;\s*$/, '');
  if (semFinal.includes(';')) {
    return 'Mais de um comando na mesma consulta. Mande um por vez, ou use o lote.';
  }

  /**
   * DDL (CREATE/ALTER/DROP/TRUNCATE/...) só passa com PERMITIR_DDL ligado.
   *
   * Fica atrás de um flag próprio, separado do PERMITIR_ESCRITA, porque é mais
   * perigoso: um `DROP TABLE PARCELAS` não tem desfazer. Ligado, serve às
   * migrações; a lista de IPs e a chave é que seguram o acesso.
   */
  if (/^\s*(drop|alter|create|recreate|truncate|grant|revoke)\b/i.test(limpo)) {
    if (!config.permitirDdl) {
      const primeira = limpo.split(/\s+/)[0]?.toUpperCase() ?? '?';
      return (
        `DDL desligado: o agente recusou "${primeira}". ` +
        'Ligue PERMITIR_DDL para permitir mudanças de estrutura (CREATE/ALTER/DROP/...).'
      );
    }
    return null; // DDL liberado (migrações)
  }

  if (config.permitirEscrita) return null;

  if (!/^\s*(select|with|execute\s+block)\b/i.test(limpo)) {
    const primeira = limpo.split(/\s+/)[0]?.toUpperCase() ?? '?';
    return (
      `Este agente está em modo somente-leitura e recusou "${primeira}". ` +
      'Para gravar, ligue PERMITIR_ESCRITA no .env do agente.'
    );
  }

  return null;
}
