import { ChromaClient } from 'chromadb';
import { OpenAIEmbeddings } from '@langchain/openai';
import * as dotenv from 'dotenv';

dotenv.config();

// Configuración
const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
const COLLECTION_NAME = 'municipalidad_info';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Cliente de ChromaDB
export const chromaClient = new ChromaClient({ path: CHROMA_URL });

// Función de embedding usando OpenAI
export const embeddingFunction = {
  generate: async (texts: string[]) => {
    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: OPENAI_API_KEY,
    });
    
    const results = await Promise.all(
      texts.map(text => embeddings.embedQuery(text))
    );
    
    return results;
  }
};

// Función para obtener o crear la colección
export async function getCollection() {
  try {
    // Intentar obtener la colección existente
    const collection = await chromaClient.getCollection({ 
      name: COLLECTION_NAME,
      embeddingFunction: embeddingFunction
    });
    console.log(`Colección existente encontrada: ${COLLECTION_NAME}`);
    return collection;
  } catch (e) {
    // Si no existe, crear una nueva
    const collection = await chromaClient.createCollection({ 
      name: COLLECTION_NAME,
      embeddingFunction: embeddingFunction
    });
    console.log(`Nueva colección creada: ${COLLECTION_NAME}`);
    return collection;
  }
}

// Exportar constantes
export { COLLECTION_NAME };
