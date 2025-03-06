@echo off
echo Ingesta de todos los documentos para Luna RAG
echo ===========================================

echo Procesando todos los documentos en data/documents
npx ts-node src/rag/ingestAll.ts

if %ERRORLEVEL% NEQ 0 (
  echo Error al procesar los documentos
  exit /b 1
) else (
  echo Todos los documentos procesados exitosamente
  exit /b 0
)
