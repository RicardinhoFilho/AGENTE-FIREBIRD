@echo off
setlocal enabledelayedexpansion
REM ================================================================
REM  INSTALAR-SERVICOS.bat  -  Sinsoft
REM  Deixe este .bat DENTRO da pasta WEB (junto de agente-firebird.exe,
REM  nginx\ e nssm\), na rede: F:\sinsoft\MIGRACAO\WEB\
REM
REM  Ele COPIA tudo para o disco LOCAL (C:\Sinsoft) e cria os servicos
REM  dali - porque servico nao roda confiavel de drive de rede.
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

echo Copiando de "%ORIGEM%" para "%DESTINO%" ...
if not exist "%DESTINO%" mkdir "%DESTINO%"
robocopy "%ORIGEM%nginx" "%DESTINO%\nginx" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%ORIGEM%nssm"  "%DESTINO%\nssm"  /E /NFL /NDL /NJH /NJS /NP >nul
copy /Y "%ORIGEM%agente-firebird.exe" "%DESTINO%\agente-firebird.exe" >nul

REM --- localiza o nssm.exe (raiz ou win64) ---
set "NSSM=%DESTINO%\nssm\nssm.exe"
if not exist "%NSSM%" set "NSSM=%DESTINO%\nssm\win64\nssm.exe"
if not exist "%NSSM%" (
  echo [ERRO] nssm.exe nao encontrado em %DESTINO%\nssm ^(nem em \win64^).
  pause & exit /b 1
)

echo.
echo === Servico AgenteFirebird ===
"%NSSM%" install AgenteFirebird "%DESTINO%\agente-firebird.exe"
"%NSSM%" set   AgenteFirebird AppDirectory "%DESTINO%"
"%NSSM%" set   AgenteFirebird Start SERVICE_AUTO_START
"%NSSM%" set   AgenteFirebird AppStdout "%DESTINO%\agente.log"
"%NSSM%" set   AgenteFirebird AppStderr "%DESTINO%\agente.log"
"%NSSM%" start AgenteFirebird

echo.
echo === Servico nginx ===
"%NSSM%" install nginx "%DESTINO%\nginx\nginx.exe"
"%NSSM%" set   nginx AppDirectory "%DESTINO%\nginx"
"%NSSM%" set   nginx Start SERVICE_AUTO_START
"%NSSM%" set   nginx AppStopMethodConsole 5000
"%NSSM%" start nginx

echo.
echo === Status ===
sc query AgenteFirebird | findstr STATE
sc query nginx | findstr STATE
echo.
echo Pronto! Servicos rodando de %DESTINO% (disco local), inicio automatico.
echo Para atualizar depois: copie o exe novo para %DESTINO% e:  "%NSSM%" restart AgenteFirebird
pause
