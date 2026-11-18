@echo off
rem Starts Claude Usage Monitor and puts it online, so you can open it from your phone.
rem   start-remote.cmd                       Cloudflare, no sign-in (anyone with the address can view)
rem   start-remote.cmd cloudflare signin     Cloudflare, access key required
rem   start-remote.cmd tailscale             Tailscale: your own devices only
rem   start-remote.cmd tailscale-funnel      Tailscale Funnel: public address
rem The address is shown on the dashboard at http://localhost:4747 and in data\monitor.log.
cd /d "%~dp0"
set TUNNEL=%~1
if "%TUNNEL%"=="" set TUNNEL=cloudflare
set AUTH=--no-sign-in
if /i "%~2"=="signin" set AUTH=
if not exist data mkdir data
rem The Windows installer bundles its own Node.js in node\; otherwise use the one on PATH.
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" server.js --tunnel %TUNNEL% %AUTH% > data\monitor.log 2>&1
