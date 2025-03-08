import { OpenAIEmbeddings } from '@langchain/openai';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { getIndex, PINECONE_INDEX_NAME } from './pineconeClient';

dotenv.config();

// Configuración
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Función para cargar un documento de texto
async function loadTextDocument(filePath: string) {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    return [{ pageContent: text, metadata: { source: filePath } }];
  } catch (error) {
    console.error(`Error al cargar el documento de texto: ${error}`);
    return [];
  }
}

// Función para dividir texto en chunks
function splitTextIntoChunks(text: string, chunkSize: number = CHUNK_SIZE, chunkOverlap: number = CHUNK_OVERLAP) {
  const chunks = [];
  let startIndex = 0;
  
  while (startIndex < text.length) {
    // Determinar el final del chunk actual
    let endIndex = startIndex + chunkSize;
    
    // Si no estamos al final del texto, intentar encontrar un buen punto de corte
    if (endIndex < text.length) {
      // Buscar el último salto de línea o punto dentro del rango
      const lastNewline = text.lastIndexOf('\n', endIndex);
      const lastPeriod = text.lastIndexOf('.', endIndex);
      
      // Usar el punto de corte más cercano al final del chunk
      if (lastNewline > startIndex && lastNewline > endIndex - chunkOverlap) {
        endIndex = lastNewline + 1; // Incluir el salto de línea
      } else if (lastPeriod > startIndex && lastPeriod > endIndex - chunkOverlap) {
        endIndex = lastPeriod + 1; // Incluir el punto
      }
    }
    
    // Extraer el chunk y añadirlo a la lista
    const chunk = text.slice(startIndex, endIndex);
    chunks.push(chunk);
    
    // Avanzar al siguiente chunk con solapamiento
    startIndex = endIndex - chunkOverlap;
    
    // Evitar chunks demasiado pequeños al final
    if (startIndex + chunkSize > text.length && startIndex < text.length - chunkOverlap) {
      chunks.push(text.slice(startIndex));
      break;
    }
  }
  
  return chunks;
}

// Función principal para ingestar documentos
export async function ingestDocument(filePath: string): Promise<boolean> {
  try {
    console.log(`Procesando documento: ${filePath}`);
    
    // 1. Verificar que el archivo existe
    if (!fs.existsSync(filePath)) {
      throw new Error(`El archivo no existe: ${filePath}`);
    }
    
    // 2. Cargar el documento como texto
    const text = fs.readFileSync(filePath, 'utf-8');
    console.log(`Documento cargado: ${filePath}`);
    
    // 3. Dividir en chunks
    const chunks = splitTextIntoChunks(text);
    console.log(`Documento dividido en ${chunks.length} chunks`);
    
    // 4. Inicializar embeddings
    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: OPENAI_API_KEY,
    });
    
    // 5. Obtener índice de Pinecone
    const index = await getIndex();
    
    // 6. Procesar y añadir chunks
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i];
      const metadata = {
        source: filePath,
        chunk_id: `${path.basename(filePath)}_${i}`,
        text: content
      };
      
      // Generar embedding
      const embedding = await embeddings.embedQuery(content);
      
      // Crear un ID único para este vector
      const id = `${path.basename(filePath).replace(/\s+/g, '_')}_${i}`;
      
      // Añadir a Pinecone
      await index.upsert([{
        id: id,
        values: embedding,
        metadata: metadata
      }]);
      
      console.log(`Añadido chunk ${i+1}/${chunks.length}`);
    }
    
    console.log(`Documento procesado exitosamente: ${filePath}`);
    return true;
  } catch (error) {
    console.error('Error al procesar el documento:', error);
    return false;
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Por favor proporciona la ruta al documento: ts-node ingestPinecone.ts /ruta/al/documento.pdf');
    process.exit(1);
  }
  
  ingestDocument(filePath)
    .then(success => {
      if (success) {
        console.log('Proceso completado exitosamente');
        process.exit(0);
      } else {
        console.error('Error al procesar el documento');
        process.exit(1);
      }
    })
    .catch(err => {
      console.error('Error inesperado:', err);
      process.exit(1);
    });
}
