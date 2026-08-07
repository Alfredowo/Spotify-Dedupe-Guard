@echo off
cd /d "%~dp0"
title Spotify Dedupe Guard
python app.py
if errorlevel 1 (
  echo.
  echo La aplicacion no pudo iniciar. Verifica que Python este instalado.
  pause
)
