@echo off
echo Ingesta de documentos para Luna RAG
echo ===================================

if "%1"=="" (
  echo Error: Debe proporcionar la ruta al documento
  echo Uso: ingest-document.bat "ruta\al\documento.txt"
  exit /b 1
)

echo Procesando documento: %1
npx ts-node src/rag/ingest.ts %1

if %ERRORLEVEL% NEQ 0 (
  echo Error al procesar el documento
  exit /b 1
) else (
  echo Documento procesado exitosamente
  exit /b 0
)
