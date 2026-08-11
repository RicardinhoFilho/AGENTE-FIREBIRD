# Deploy do Agente Firebird

Pacote pronto pra instalar em qualquer prefeitura. O agente roda **sem `.env`**
(chave, porta, IPs — tudo embutido no exe, vindo do `src/`).

## Arquivos
- `agente-firebird.exe.zip` — o executável (extraia o `.exe`). Zipado porque o
  binário tem ~36MB; extraído, roda sozinho.
- `nginx-agente.conf` — nginx na porta 1000 encaminhando pro agente (3060). **Use este.**
- `nginx-agente-BALANCEADO.conf` — opcional, só se um dia precisar de várias instâncias.

## Instalar na prefeitura
1. Extraia o `agente-firebird.exe` numa pasta (ex.: `C:\agente`).
2. Rode como serviço (uma das opções):
   - **NSSM** (não precisa de Node):
     ```
     nssm.exe install AgenteFirebird "C:\agente\agente-firebird.exe"
     nssm.exe set AgenteFirebird AppDirectory "C:\agente"
     nssm.exe set AgenteFirebird Start SERVICE_AUTO_START
     nssm.exe start AgenteFirebird
     ```
   - **PM2**: `pm2 start agente-firebird.exe --name agente-firebird --interpreter none && pm2 save`
3. Coloque o `nginx-agente.conf` em `C:\nginx\conf\nginx.conf` e:
   `cd C:\nginx & nginx -t & nginx -s reload`
4. A borda da rede deve redirecionar a **porta pública 1000** para o servidor:1000.

## Testar
- No servidor (de um IP autorizado): `http://143.255.1.235:1000/health` → `{"ok":true,...}`
- IP fora da lista recebe **403** (inclusive no /health — é proposital).

## Atualizar
Ao mexer no fonte (`src/`), rode `npm run empacotar` (gera exe node16), zipe o
`.exe` e substitua o `agente-firebird.exe.zip` desta pasta. Commit no GitHub e
pronto — é só puxar em cada cliente.

## IPs autorizados (ficam em `src/config.ts` -> IPS_FIXOS)
- 191.252.64.232 (nuvem/APIs)
- 162.120.186.185 (Sinsoft)
- 201.130.94.250
