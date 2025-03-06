import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { pineconeClient, PINECONE_INDEX_NAME } from '../src/rag/pineconeClient';

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

// Función para eliminar el índice de Pinecone
async function limpiarPinecone(): Promise<void> {
  try {
    console.log(`Eliminando índice ${PINECONE_INDEX_NAME} de Pinecone...`);
    
    // Obtener el cliente de Pinecone
    const client = pineconeClient;
    
    try {
      // Verificar si el índice existe
      const indexList = await client.listIndexes();
      
      // Verificar si el índice existe en la lista de índices
      const indexExists = indexList.indexes?.some(index => index.name === PINECONE_INDEX_NAME);
      
      if (indexExists) {
        // Eliminar el índice
        await client.deleteIndex(PINECONE_INDEX_NAME);
        console.log(`Índice ${PINECONE_INDEX_NAME} eliminado exitosamente.`);
      } else {
        console.log(`El índice ${PINECONE_INDEX_NAME} no existe.`);
      }
    } catch (error) {
      console.log(`Error al eliminar el índice de Pinecone: ${error}`);
    }
  } catch (error) {
    console.error('Error al limpiar Pinecone:', error);
  }
}

// Función principal
async function main() {
  try {
    console.log('Iniciando limpieza del sistema RAG con Pinecone...');
    
    // 1. Limpiar directorios de documentos
    limpiarDirectorio(MUNICIPIO_DIR);
    limpiarDirectorio(PROCESADOS_DIR);
    
    // 2. Limpiar Pinecone
    await limpiarPinecone();
    
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
