import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { chromaClient, COLLECTION_NAME, embeddingFunction } from '../src/rag/chromaClient';

// Cargar variables de entorno
dotenv.config();

// Directorios de documentos
const MUNICIPIO_DIR = path.join(__dirname, '../data/documents/municipio');
const PROCESADOS_DIR = path.join(__dirname, '../data/documents/procesados');

// Función para eliminar archivos de un directorio
function limpiarDirectorio(directorio: string): void {
  if (!fs.existsSync(directorio)) {
    console.log(`El directorio ${directorio} no existe.`);
    return;
  }

  const archivos = fs.readdirSync(directorio);
  
  console.log(`Eliminando ${archivos.length} archivos de ${directorio}...`);
  
  for (const archivo of archivos) {
    const rutaArchivo = path.join(directorio, archivo);
    
    // Verificar si es un archivo (no un directorio)
    if (fs.statSync(rutaArchivo).isFile()) {
      fs.unlinkSync(rutaArchivo);
      console.log(`Eliminado: ${rutaArchivo}`);
    }
  }
  
  console.log(`Directorio ${directorio} limpiado exitosamente.`);
}

// Función para eliminar la colección de ChromaDB
async function limpiarChromaDB(): Promise<void> {
  try {
    console.log(`Eliminando colección ${COLLECTION_NAME} de ChromaDB...`);
    
    // Obtener el cliente de Chroma
    const client = chromaClient;
    
    try {
      // Intentar eliminar la colección directamente
      await client.deleteCollection({ name: COLLECTION_NAME });
      console.log(`Colección ${COLLECTION_NAME} eliminada exitosamente.`);
    } catch (error) {
      // Si hay un error, probablemente la colección no existe
      console.log(`La colección ${COLLECTION_NAME} no existe o no se pudo eliminar: ${error}`);
    }
  } catch (error) {
    console.error('Error al limpiar ChromaDB:', error);
  }
}

// Función principal
async function main() {
  try {
    console.log('Iniciando limpieza del sistema RAG...');
    
    // 1. Limpiar directorios de documentos
    limpiarDirectorio(MUNICIPIO_DIR);
    limpiarDirectorio(PROCESADOS_DIR);
    
    // 2. Limpiar ChromaDB
    await limpiarChromaDB();
    
    console.log('Limpieza del sistema RAG completada exitosamente.');
    console.log('Ahora puedes ejecutar el script de scraping mejorado para ingestar solo información relevante.');
  } catch (error) {
    console.error('Error durante la limpieza:', error);
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  main().catch(console.error);
}
