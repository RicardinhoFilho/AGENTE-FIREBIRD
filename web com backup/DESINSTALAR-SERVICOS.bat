@echo off
setlocal enabledelayedexpansion
REM ================================================================
REM  DESINSTALAR-SERVICOS.bat  -  Sinsoft
REM  Desfaz o que o INSTALAR-SERVICOS.bat fez: para e remove os
REM  servicos AgenteFirebird e nginx, e (se voce mandar) apaga a
REM  pasta C:\Sinsoft.
REM
REM  Pode rodar de qualquer lugar - ele so mexe em C:\Sinsoft.
REM
REM  >>> Rode como ADMINISTRADOR (botao direito > Executar como administrador) <<<
REM ================================================================

set "DESTINO=C:\Sinsoft"

REM --- checa admin ---
net session >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Rode este arquivo como ADMINISTRADOR.
  pause & exit /b 1
)

REM --- localiza o nssm.exe (raiz ou win64). Pode nao existir mais: o
REM     "sc delete" mais abaixo da conta do recado sozinho.
set "NSSM=%DESTINO%\nssm\nssm.exe"
if not exist "%NSSM%" set "NSSM=%DESTINO%\nssm\win64\nssm.exe"
if not exist "%NSSM%" set "NSSM="

echo.
echo === Parando os servicos ===
sc stop AgenteFirebird >nul 2>&1
sc stop nginx >nul 2>&1

REM Da um tempo para o Windows fechar os processos antes de remover.
timeout /t 3 /nobreak >nul

REM O nginx deixa processos worker para tras quando roda como servico, e um
REM worker vivo segura os arquivos da pasta - o que faria a remocao abaixo
REM falhar com "acesso negado" sem explicar o motivo.
taskkill /F /IM nginx.exe /T >nul 2>&1
taskkill /F /IM agente-firebird.exe /T >nul 2>&1

echo.
echo === Removendo os servicos ===
if defined NSSM (
  "%NSSM%" remove AgenteFirebird confirm
  "%NSSM%" remove nginx confirm
) else (
  echo [aviso] nssm.exe nao encontrado; removendo pelo sc.
  sc delete AgenteFirebird
  sc delete nginx
)

echo.
echo === Conferindo ===
sc query AgenteFirebird >nul 2>&1
if errorlevel 1 (echo AgenteFirebird: removido) else (echo AgenteFirebird: AINDA EXISTE)
sc query nginx >nul 2>&1
if errorlevel 1 (echo nginx: removido) else (echo nginx: AINDA EXISTE)

echo.
echo ================================================================
echo  Apagar tambem a pasta %DESTINO% ?
echo.
echo  Ela guarda o .env desta prefeitura (IPs liberados, pool, backup)
echo  e o agente.log. Apagando, essa configuracao se perde - se for
echo  so trocar a versao do agente, NAO apague.
echo ================================================================
set "APAGAR="
set /p "APAGAR=Digite APAGAR para remover a pasta, ou Enter para manter: "

if /i "!APAGAR!"=="APAGAR" (
  echo Removendo %DESTINO% ...
  rmdir /S /Q "%DESTINO%"
  if exist "%DESTINO%" (
    echo [aviso] Sobrou coisa em %DESTINO% - algum arquivo ainda estava em uso.
    echo         Reinicie a maquina e apague a pasta na mao.
  ) else (
    echo Pasta removida.
  )
) else (
  echo Pasta mantida em %DESTINO%.
)

echo.
echo Pronto.
pause
