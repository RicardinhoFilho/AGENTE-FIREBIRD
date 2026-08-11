# Agente Firebird — Sinsoft

Fica **dentro da prefeitura**, ao lado do banco. Recebe de um sistema da casa a
conexão e a consulta, executa no Firebird local e devolve JSON.

Não tem regra de negócio nenhuma — e é essa burrice que faz dele algo que se
instala uma vez e não se atualiza mais. Quando uma consulta muda, quem muda é o
sistema que chama, lá na nuvem.

```
  nuvem (RELATORIO, ARRECADACAO...)        prefeitura
  ┌────────────────────────────┐          ┌──────────────────────────┐
  │ monta o SQL e as regras    │  HTTPS   │ agente  →  Firebird      │
  │ recebe o JSON pronto       │ ───────► │ (este)     local         │
  └────────────────────────────┘          └──────────────────────────┘
```

---

## Instalação

```bash
npm install
cp .env.example .env
# gere a chave e cole no .env:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run build && npm start
```

O agente **não sobe sem `AGENTE_CHAVE`**. Ele executa SQL num banco de
prefeitura; sem chave, qualquer um na rede faria o mesmo.

---

## Endpoints

### `GET /saude`

```json
{ "ok": true, "servico": "agente-firebird", "somenteLeitura": true }
```

### `POST /consultar`

```jsonc
// Authorization: Bearer <AGENTE_CHAVE>
{
  "banco": {
    "host": "192.168.22.247",
    "porta": 3050,
    "caminho": "/home/bases/SIAFIC2026.GDB",  // caminho no servidor da prefeitura
    "versao": "3.0"                            // decide a senha do SYSDBA
  },
  "sql": "SELECT CAST(DEPTO AS VARCHAR(60) CHARACTER SET OCTETS) AS DEPTO FROM ORGAOS",
  "parametros": [],
  "codificacao": "win1252"                     // win1252 | latin1 | base64
}
```

```json
{ "ok": true, "linhas": [{ "DEPTO": "SECRETARIA DA EDUCAÇÃO" }], "total": 1, "ms": 3 }
```

### `POST /lote`

**É este que paga o desenho.** O Demonstrativo de Educação são 17 consultas; uma
a uma, cada ida e volta pela internet somaria ao tempo do relatório. Em lote é
uma viagem só, e por padrão elas rodam em paralelo.

```jsonc
{
  "banco": { "...": "igual acima" },
  "consultas": [
    { "nome": "receitas", "sql": "SELECT ...", "parametros": [] },
    { "nome": "despesas", "sql": "SELECT ...", "parametros": [] }
  ]
}
```

Uma consulta que falha **não derruba as outras** — o erro dela vem no lugar dela:

```json
{
  "ok": true,
  "ms": 32,
  "resultados": [
    { "nome": "receitas", "linhas": [], "total": 17, "ms": 12 },
    { "nome": "despesas", "ms": 0, "erro": "Dynamic SQL Error, SQL error code = -204" }
  ]
}
```

---

## Decisões que parecem estranhas (e por quê)

| Coisa | Por quê |
|---|---|
| **Somente leitura por padrão** | Os relatórios só leem. Um agente que só lê não consegue apagar um exercício inteiro se a chave vazar. Quem precisa gravar liga `PERMITIR_ESCRITA` e assume o risco — e, mesmo assim, o certo é restringir também no Firebird |
| **Recusa `;` no meio da consulta** | O driver só executaria o primeiro comando, mas aceitar `;` é o convite clássico para injeção do outro lado: se quem chama concatenar texto de usuário no SQL, é aqui que a emenda apareceria |
| **Tira comentários antes de validar** | Sem isso, um `/* ok */ DELETE FROM ANUAL` passaria pela checagem de "começa com SELECT" |
| **Senha vem da `versao`, não do cadastro** | Mesma regra dos outros sistemas da casa: 1.5 → `masterkey`, 3.x → `SIN_S1_S2`. O que vale é o número maior da string, não o texto — a coluna aparece como "3.0", "3", " 1.5 " |
| **`codificacao` na requisição** | As bases são charset NONE guardando bytes de 8 bits, então texto chega como `Buffer`. O RELATORIO lê em `win1252`, a ARRECADACAO em `latin1`; quem preferir decodificar por conta pede `base64` |
| **Datas ISO viram `Date`** | JSON não tem tipo data. O driver precisa de `Date` para comparar com colunas DATE/TIMESTAMP, então `"2026-07-01"` é convertido na entrada |
| **`MAX_LINHAS`** | O link de prefeitura costuma ter upload magro. Uma consulta sem `WHERE` não pode entupir a saída — o corte vem sinalizado com `"cortado": true` |
| **Um pool por banco** | O agente atende vários sistemas e às vezes mais de um exercício do mesmo servidor. Se a abertura falhar, o pool sai do cache para a próxima requisição tentar de novo |
| **Erro sempre em JSON** | Sem o handler, um corpo malformado faz o Express devolver HTML com stack trace — quem chama espera JSON, e o caminho dos arquivos do servidor vazaria na resposta |

---

## Conferir a instalação

```bash
node teste.js
```

Bate no agente com os casos que costumam quebrar: sem chave, chave errada,
`DELETE` (recusado), `DELETE` atrás de comentário, dois comandos, parâmetro de
data, acento nas três codificações, banco inexistente e um lote com uma consulta
quebrada.

Última execução contra o SIAFIC2026 local:

```
401  sem chave                    Chave ausente ou inválida
401  chave errada                 Chave ausente ou inválida
400  sem banco                    Faltou o objeto `banco`.
200  SELECT com acento            2 linhas em 3ms
400  DELETE (so-leitura)          ...recusou "DELETE"
400  DELETE atras de comentario   ...recusou "DELETE"
400  dois comandos                Mais de um comando na mesma consulta.
200  parametro data               1 linhas -> {"N":1746}
200  acento em win1252            SECRETARIA DA EDUCAÇÃO
502  banco inexistente            Não achei o banco em C:\nao\existe.GDB...
200  lote (4, uma quebrada)       orgaos:2  empenhos:1  liquidacoes:1  quebrada:ERRO
     lote inteiro em 32ms
```

---

## Quem já fala com o agente

**ARRECADACAO** — ligado por `AGENTE_URL` no `.env` da API dela. Vazio, ela
conecta direto no Firebird como sempre; preenchido, o `query()` passa a mandar a
consulta para cá. A assinatura não mudou, então **nenhum Repository foi tocado**.
Ver `ARRECADACAO/api/src/Database/agente.ts`.

Conferido de ponta a ponta contra o SIAFIC2026 local (com o stub de endereços):

| | |
|---|---|
| SELECT simples | `[{"UM":1}]` |
| Acento em latin1 | `SECRETARIA DA EDUCAÇÃO` — igual à conexão direta |
| Parâmetro de data ISO | `[{"N":1746}]` |
| Erro de SQL | chega legível, não como "HTTP 502" |
| Sem contexto de entidade | erro claro em vez de conexão errada |

**RELATORIO** — ainda não. Ele já resolve o banco por entidade, então a ponte é a
mesma; falta fazer.

## O que ainda falta

- **Ninguém usa `/lote` ainda.** A ARRECADACAO manda uma consulta por vez, que é
  o suficiente para ela. O ganho grande é no RELATORIO, onde a Educação são 17
  consultas: para virar uma viagem só, os Service de lá precisam montar a lista
  em vez de disparar `Promise.all` de `query()` soltos.
- **Nada foi testado de dentro da rede de uma prefeitura.** Aqui o agente e o
  banco estão na mesma máquina; o comportamento com o link real (latência,
  upload magro, túnel caindo) ainda é previsão.
