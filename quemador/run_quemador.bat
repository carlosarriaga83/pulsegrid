@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Creando entorno virtual del quemador...
  python -m venv .venv
  if errorlevel 1 (
    echo No se pudo crear el entorno virtual. Verifica que Python este instalado.
    pause
    exit /b 1
  )
)
echo Verificando dependencias...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo No se pudieron instalar las dependencias.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" "quemador.py"
endlocal
