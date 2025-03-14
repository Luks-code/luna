import * as fs from 'fs';
import * as path from 'path';
import { ingestDocument } from '../src/rag/ingestPinecone';
import * as dotenv from 'dotenv';

dotenv.config();

// Directorio de documentos procesados
const DOCUMENTS_DIR = path.resolve(__dirname, '../data/documents/procesados');

// Función para ingestar todos los documentos
async function ingestAllDocuments() {
  console.log('=== INICIANDO INGESTA DE TODOS LOS DOCUMENTOS EN PINECONE ===');
  
  try {
    // Verificar que el directorio existe
    if (!fs.existsSync(DOCUMENTS_DIR)) {
      throw new Error(`El directorio ${DOCUMENTS_DIR} no existe`);
    }
    
    // Obtener lista de archivos
    const files = fs.readdirSync(DOCUMENTS_DIR);
    
    // Filtrar solo archivos de texto
    const textFiles = files.filter(file => 
      file.endsWith('.txt') || file.endsWith('.md')
    );
    
    console.log(`Se encontraron ${textFiles.length} documentos para procesar`);
    
    // Procesar cada archivo
    for (let i = 0; i < textFiles.length; i++) {
      const file = textFiles[i];
      const filePath = path.join(DOCUMENTS_DIR, file);
      
      console.log(`\nProcesando documento ${i+1}/${textFiles.length}: ${file}`);
      
      // Ingestar archivo
      await ingestDocument(filePath);
      
      console.log(`Documento ${file} procesado exitosamente`);
    }
    
    console.log('\n=== INGESTA COMPLETADA CON ÉXITO ===');
    console.log(`Se han procesado ${textFiles.length} documentos y almacenado en Pinecone`);
    
  } catch (error) {
    console.error('Error durante la ingesta de documentos:', error);
    process.exit(1);
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  ingestAllDocuments().catch(console.error);
}
