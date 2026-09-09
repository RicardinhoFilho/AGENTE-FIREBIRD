@echo off
setlocal
REM ================================================================
REM  INSTALAR-SERVICOS-LOCAL.bat  -  Sinsoft
REM  Instala os servicos A PARTIR DESTA PASTA (deve ser LOCAL, ex.: C:\Sinsoft).
REM  Pre-requisito: esta pasta ja contem  agente-firebird.exe , nginx\ e nssm\
REM  (copiados da rede antes).  >>> Rode como ADMINISTRADOR <<<
REM ================================================================
set "BASE=%~dp0"
if "%BASE:~-1%"=="\" set "BASE=%BASE:~0,-1%"

net session >nul 2>&1
if errorlevel 1 ( echo [ERRO] Rode este arquivo como ADMINISTRADOR. & pause & exit /b 1 )

echo Instalando a partir de: %BASE%
echo(

if not exist "%BASE%\agente-firebird.exe" ( echo [ERRO] Falta agente-firebird.exe em %BASE% & pause & exit /b 1 )
if not exist "%BASE%\nginx\nginx.exe"     ( echo [ERRO] Falta nginx\nginx.exe em %BASE%     & pause & exit /b 1 )

set "NSSM=%BASE%\nssm\nssm.exe"
if not exist "%NSSM%" set "NSSM=%BASE%\nssm\win64\nssm.exe"
if not exist "%NSSM%" ( echo [ERRO] Falta nssm.exe em %BASE%\nssm ^(ou \win64^) & pause & exit /b 1 )

echo === Servico AgenteFirebird ===
"%NSSM%" install AgenteFirebird "%BASE%\agente-firebird.exe"
"%NSSM%" set   AgenteFirebird AppDirectory "%BASE%"
"%NSSM%" set   AgenteFirebird Start SERVICE_AUTO_START
"%NSSM%" set   AgenteFirebird AppStdout "%BASE%\agente.log"
"%NSSM%" set   AgenteFirebird AppStderr "%BASE%\agente.log"
REM Rotaciona o log: sem isto o agente.log cresce para sempre. Numa prefeitura
REM com 20 bancos por noite ele passou de 190 mil linhas em semanas - e agora a
REM verificacao escreve as linhas do gbak da restauracao tambem.
"%NSSM%" set   AgenteFirebird AppRotateFiles 1
"%NSSM%" set   AgenteFirebird AppRotateOnline 1
"%NSSM%" set   AgenteFirebird AppRotateBytes 10485760
"%NSSM%" start AgenteFirebird

echo(
echo === Servico nginx ===
"%NSSM%" install nginx "%BASE%\nginx\nginx.exe"
"%NSSM%" set   nginx AppDirectory "%BASE%\nginx"
"%NSSM%" set   nginx Start SERVICE_AUTO_START
"%NSSM%" set   nginx AppStopMethodConsole 5000
"%NSSM%" start nginx

echo(
echo === Status ===
sc query AgenteFirebird | findstr STATE
sc query nginx | findstr STATE
echo(
echo Pronto. Servicos rodando de %BASE% (disco local), inicio automatico.
pause
