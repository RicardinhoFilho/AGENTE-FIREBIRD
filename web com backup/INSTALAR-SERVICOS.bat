@echo off
setlocal enabledelayedexpansion
REM ================================================================
REM  INSTALAR-SERVICOS.bat  -  Sinsoft
REM  Deixe este .bat DENTRO da pasta WEB (junto de agente-firebird.exe,
REM  nginx\, nssm\ e firebird\), na rede: F:\sinsoft\MIGRACAO\WEB\
REM
REM  Ele COPIA tudo para o disco LOCAL (C:\Sinsoft) e cria os servicos
REM  dali - porque servico nao roda confiavel de drive de rede.
REM
REM  Serve tanto para instalar do zero quanto para ATUALIZAR: se os
REM  servicos ja existirem, ele para, troca os arquivos e sobe de novo.
REM
REM  >>> Rode como ADMINISTRADOR (botao direito > Executar como administrador) <<<
REM ================================================================

set "ORIGEM=%~dp0"
set "DESTINO=C:\Sinsoft"

REM --- checa admin ---
net session >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Rode este arquivo como ADMINISTRADOR.
  pause & exit /b 1
)

REM ================================================================
REM  PARA os servicos ANTES de copiar.
REM
REM  O Windows tranca o .exe de um processo em execucao: com o agente
REM  no ar, o "copy" abaixo falha com acesso negado e - como a linha
REM  termina em >nul - a falha passa despercebida. O instalador diz
REM  "Pronto" e a maquina segue rodando a versao antiga.
REM ================================================================
echo Parando servicos (se ja existirem) ...
sc stop AgenteFirebird >nul 2>&1
sc stop nginx >nul 2>&1
timeout /t 3 /nobreak >nul
REM O nginx deixa workers para tras; um worker vivo segura os arquivos.
taskkill /F /IM nginx.exe /T >nul 2>&1
taskkill /F /IM agente-firebird.exe /T >nul 2>&1

echo Copiando de "%ORIGEM%" para "%DESTINO%" ...
if not exist "%DESTINO%" mkdir "%DESTINO%"
robocopy "%ORIGEM%nginx" "%DESTINO%\nginx" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%ORIGEM%nssm"  "%DESTINO%\nssm"  /E /NFL /NDL /NJH /NJS /NP >nul
REM gbak portatil (firebird\1.5 e firebird\3.0). Sem ele a rota /backup nao
REM funciona onde o Firebird nao esta instalado NESTA maquina - que e a maioria,
REM porque o banco costuma morar em outro servidor.
robocopy "%ORIGEM%firebird" "%DESTINO%\firebird" /E /NFL /NDL /NJH /NJS /NP >nul

REM Aqui a falha NAO pode passar batido: e o binario do agente.
copy /Y "%ORIGEM%agente-firebird.exe" "%DESTINO%\agente-firebird.exe" >nul
if errorlevel 1 (
  echo.
  echo [ERRO] Nao consegui copiar o agente-firebird.exe para %DESTINO%.
  echo        Quase sempre e o servico ainda de pe segurando o arquivo.
  echo        Pare no Servicos do Windows, ou reinicie a maquina, e rode de novo.
  pause & exit /b 1
)

REM --- localiza o nssm.exe (raiz ou win64) ---
set "NSSM=%DESTINO%\nssm\nssm.exe"
if not exist "%NSSM%" set "NSSM=%DESTINO%\nssm\win64\nssm.exe"
if not exist "%NSSM%" (
  echo [ERRO] nssm.exe nao encontrado em %DESTINO%\nssm ^(nem em \win64^).
  pause & exit /b 1
)

echo.
echo === Servico AgenteFirebird ===
REM Instala so se ainda nao existir; se existir, os "set" abaixo reconfiguram.
sc query AgenteFirebird >nul 2>&1
if errorlevel 1 (
  "%NSSM%" install AgenteFirebird "%DESTINO%\agente-firebird.exe"
) else (
  echo Servico ja existe - atualizando a configuracao.
)
"%NSSM%" set   AgenteFirebird Application "%DESTINO%\agente-firebird.exe"
"%NSSM%" set   AgenteFirebird AppDirectory "%DESTINO%"
"%NSSM%" set   AgenteFirebird Start SERVICE_AUTO_START
"%NSSM%" set   AgenteFirebird AppStdout "%DESTINO%\agente.log"
"%NSSM%" set   AgenteFirebird AppStderr "%DESTINO%\agente.log"
REM Rotaciona o log: sem isto o agente.log cresce para sempre. Numa prefeitura
REM com 20 bancos por noite ele passou de 190 mil linhas em semanas - e agora a
REM verificacao escreve as linhas do gbak da restauracao tambem.
"%NSSM%" set   AgenteFirebird AppRotateFiles 1
"%NSSM%" set   AgenteFirebird AppRotateOnline 1
"%NSSM%" set   AgenteFirebird AppRotateBytes 10485760
"%NSSM%" start AgenteFirebird

echo.
echo === Servico nginx ===
sc query nginx >nul 2>&1
if errorlevel 1 (
  "%NSSM%" install nginx "%DESTINO%\nginx\nginx.exe"
) else (
  echo Servico ja existe - atualizando a configuracao.
)
"%NSSM%" set   nginx Application "%DESTINO%\nginx\nginx.exe"
"%NSSM%" set   nginx AppDirectory "%DESTINO%\nginx"
"%NSSM%" set   nginx Start SERVICE_AUTO_START
"%NSSM%" set   nginx AppStopMethodConsole 5000
"%NSSM%" start nginx

echo.
echo === Status ===
REM Windows em portugues imprime ESTADO, nao STATE - por isso os dois.
sc query AgenteFirebird | findstr /i "STATE ESTADO"
sc query nginx | findstr /i "STATE ESTADO"

echo.
echo === Versao que ficou instalada ===
REM Confirma que o binario trocou mesmo: a data tem que ser a de hoje.
dir "%DESTINO%\agente-firebird.exe" | findstr /i "agente-firebird"

echo.
echo Pronto^! Servicos rodando de %DESTINO% ^(disco local^), inicio automatico.
echo Log em %DESTINO%\agente.log
pause
