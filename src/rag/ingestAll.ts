import { ingestDocument } from './ingest';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Script para ingestar todos los documentos en el directorio de documentos
 * Uso: ts-node src/rag/ingestAll.ts
 */
async function ingestAllDocuments() {
  // Directorio de documentos
  const documentsDir = path.join(process.cwd(), 'data', 'documents');
  
  console.log(`Buscando documentos en: ${documentsDir}`);
  
  try {
    // Verificar que el directorio existe
    if (!fs.existsSync(documentsDir)) {
      console.error(`El directorio ${documentsDir} no existe`);
      process.exit(1);
    }
    
    // Leer todos los archivos en el directorio
    const files = fs.readdirSync(documentsDir);
    
    if (files.length === 0) {
      console.log('No se encontraron documentos para procesar');
      process.exit(0);
    }
    
    console.log(`Se encontraron ${files.length} documentos para procesar`);
    
    // Procesar cada archivo
    for (const file of files) {
      const filePath = path.join(documentsDir, file);
      
      // Verificar que es un archivo y no un directorio
      if (fs.statSync(filePath).isFile()) {
        console.log(`\nProcesando: ${file}`);
        
        // Ingestar el documento
        const success = await ingestDocument(filePath);
        
        if (success) {
          console.log(`✅ Documento procesado exitosamente: ${file}`);
        } else {
          console.error(`❌ Error al procesar el documento: ${file}`);
        }
      }
    }
    
    console.log('\n✅ Proceso de ingesta completado');
  } catch (error) {
    console.error('Error al procesar los documentos:', error);
    process.exit(1);
  }
}

// Ejecutar la función principal
ingestAllDocuments();
