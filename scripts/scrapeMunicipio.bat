@echo off
echo Scraping de la página municipal para Luna RAG
echo ==========================================

echo Instalando dependencias necesarias...
npm install puppeteer openai

echo Ejecutando script de scraping...
npx ts-node scripts/scrapeMunicipioPinecone.ts

if %ERRORLEVEL% NEQ 0 (
  echo Error al ejecutar el script de scraping
  exit /b 1
) else (
  echo Proceso de scraping completado exitosamente
  exit /b 0
)
