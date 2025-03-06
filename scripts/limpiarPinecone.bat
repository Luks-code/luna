@echo off
echo Limpieza del sistema RAG para Luna (Pinecone)
echo ================================

echo Ejecutando script de limpieza...
npx ts-node scripts/limpiarPinecone.ts

if %ERRORLEVEL% NEQ 0 (
  echo Error al ejecutar el script de limpieza
  exit /b 1
) else (
  echo Proceso de limpieza completado exitosamente
  exit /b 0
)
