import fs from 'fs';
import path from 'path';
import { config } from './config';

/**
 * Leitura de arquivos do servidor da prefeitura.
 *
 * Existe para a migracao: os sistemas antigos guardam anexos em pasta (PDFs
 * assinados, digitalizacoes, laudos), e eles precisam vir junto com os dados.
 * O agente ja esta la dentro, entao e ele quem alcanca esses arquivos.
 *
 * O caminho vem de QUEM CHAMA, e e isso que torna esta rota perigosa: sem
 * trava, ela le o `.env` do proprio agente, os `.GDB`, o SAM do Windows. A
 * trava e a lista `ARQUIVOS_PASTAS`, e esta no .env de cada maquina — quem
 * instala decide o que o agente enxerga.
 */

export interface ArquivoListado {
  nome: string;
  caminho: string;
  bytes: number;
  modificadoEm: string;
}

/** Erro com status HTTP junto, para a rota nao ter que adivinhar. */
export class ErroArquivo extends Error {
  constructor(readonly status: number, mensagem: string) {
    super(mensagem);
  }
}

/**
 * Normaliza para comparar caminho de Windows.
 *
 * `path.resolve` ja resolve `..` e barras trocadas; falta so o caixa, porque no
 * Windows `D:\Anexos` e `d:\anexos` sao a mesma pasta e uma comparacao sensivel
 * a maiusculas deixaria passar ou barraria errado.
 */
function normalizar(caminho: string): string {
  return path.resolve(caminho).toLowerCase();
}

/**
 * `filho` esta dentro de `pai`?
 *
 * O separador no fim nao e detalhe: sem ele, `D:\anexos-secretos` passaria como
 * se estivesse dentro de `D:\anexos`, por ser prefixo de texto.
 */
function dentroDe(filho: string, pai: string): boolean {
  const a = normalizar(filho);
  const b = normalizar(pai);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * Resolve o caminho pedido e recusa o que estiver fora das pastas liberadas.
 *
 * Usa `realpathSync` antes de comparar: sem isso, um atalho (junction) dentro
 * de uma pasta liberada apontando para `C:\Windows` passaria na checagem e
 * entregaria o que esta do outro lado.
 */
export function resolverCaminho(pedido: string): string {
  // if (config.arquivosPastas.length === 0) {
  //   throw new ErroArquivo(
  //     403,
  //     'Leitura de arquivos desligada neste agente. Liste as pastas liberadas em ' +
  //       'ARQUIVOS_PASTAS no .env (ex.: ARQUIVOS_PASTAS=D:\\anexos;E:\\docs).'
  //   );
  // }

  if (typeof pedido !== 'string' || !pedido.trim()) {
    throw new ErroArquivo(400, 'Faltou o caminho do arquivo.');
  }

  let real: string;
  try {
    real = fs.realpathSync(path.resolve(pedido));
  } catch {
    // Mesma mensagem para "nao existe" e "sem permissao": dizer qual e das duas
    // deixaria mapear o disco da prefeitura por tentativa e erro.
    throw new ErroArquivo(404, `Nao encontrei "${pedido}" no servidor da prefeitura.`);
  }

  const liberada = config.arquivosPastas.some(raiz => {
    try {
      return dentroDe(real, fs.realpathSync(path.resolve(raiz)));
    } catch {
      return false; // raiz configurada que nao existe mais nao libera nada
    }
  });

  if (!liberada) {
    throw new ErroArquivo(
      403,
      `Caminho fora das pastas liberadas. Este agente so le de: ${config.arquivosPastas.join(', ')}.`
    );
  }

  return real;
}

/**
 * Content-Type pela extensao.
 *
 * Lista curta de proposito: o que aparece em anexo de prefeitura. O que nao
 * estiver aqui vai como `octet-stream`, que faz o navegador baixar em vez de
 * tentar abrir — comportamento seguro para arquivo de terceiro.
 */
const TIPOS: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.rem': 'text/plain; charset=utf-8',
  '.ret': 'text/plain; charset=utf-8',
};

export function tipoPorExtensao(caminho: string): string {
  return TIPOS[path.extname(caminho).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * So estas extensoes podem ser baixadas.
 *
 * Esta e a trava que torna seguro aceitar caminho livre: os arquivos perigosos
 * NAO estao nesta lista. O `.env` do agente (que tem a chave), os `.GDB`/`.FDB`
 * (bancos inteiros), o `.exe`/`.dll`, os arquivos de senha do Windows — nenhum
 * casa, entao a rota nunca os entrega, mesmo recebendo o caminho exato deles.
 *
 * Sao as mesmas extensoes de anexo que o TIPOS ja conhece.
 */
const EXTENSOES_PERMITIDAS = new Set(Object.keys(TIPOS));

/** Um arquivo, ja validado. Lanca se for pasta, extensao proibida, ou passar do teto. */
export function abrirArquivo(pedido: string): { caminho: string; bytes: number } {
  const caminho = resolverCaminho(pedido);
  const info = fs.statSync(caminho);

  if (info.isDirectory()) {
    throw new ErroArquivo(400, `"${pedido}" e uma pasta.`);
  }

  const ext = path.extname(caminho).toLowerCase();
  if (!EXTENSOES_PERMITIDAS.has(ext)) {
    throw new ErroArquivo(
      403,
      `Este agente so entrega anexos (${[...EXTENSOES_PERMITIDAS].join(', ')}). ` +
        `"${ext || 'sem extensao'}" nao e permitido.`
    );
  }

  // 0 = sem teto (padrao)
  const maxBytes = config.arquivosMaxMb * 1024 * 1024;
  if (maxBytes > 0 && info.size > maxBytes) {
    throw new ErroArquivo(
      413,
      `Arquivo de ${Math.round(info.size / 1048576)} MB passa do teto de ` +
        `${config.arquivosMaxMb} MB. Aumente ARQUIVOS_MAX_MB no .env se for mesmo necessario.`
    );
  }

  return { caminho, bytes: info.size };
}

/**
 * Lista uma pasta liberada.
 *
 * Sem isto, quem migra teria que ja saber o nome de cada anexo — e os sistemas
 * antigos guardam o nome no banco de jeitos diferentes. Listar e o que permite
 * conferir o que existe antes de baixar.
 */
export function listarPasta(pedido: string, recursivo: boolean): ArquivoListado[] {
  const pasta = resolverCaminho(pedido);

  if (!fs.statSync(pasta).isDirectory()) {
    throw new ErroArquivo(400, `"${pedido}" nao e uma pasta.`);
  }

  const achados: ArquivoListado[] = [];

  const andar = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (recursivo) andar(completo);
        continue;
      }
      if (!item.isFile()) continue; // ignora link/dispositivo
      try {
        const info = fs.statSync(completo);
        achados.push({
          nome: item.name,
          caminho: completo,
          bytes: info.size,
          modificadoEm: info.mtime.toISOString(),
        });
      } catch {
        /* arquivo sumiu ou sem permissao: segue a lista */
      }
    }
  };

  andar(pasta);
  return achados;
}
