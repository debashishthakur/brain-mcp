@echo off
rem Started by the "brain-mcp" scheduled task at boot. Keeps the working directory and env stable.
cd /d "%~dp0.."
set BRAIN_MCP_AUTH_MODE=oauth
set NODE_ENV=production
if not exist logs mkdir logs
node dist\index.js --oauth >> logs\service.log 2>&1
