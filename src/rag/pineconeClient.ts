import { Pinecone } from '@pinecone-database/pinecone';
import { OpenAIEmbeddings } from '@langchain/openai';
import * as dotenv from 'dotenv';

dotenv.config();

// Configuración de Pinecone
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'municipalidad-info';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Verificar que las variables de entorno estén configuradas
if (!PINECONE_API_KEY) {
  throw new Error('PINECONE_API_KEY no está configurado en las variables de entorno');
}

if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY no está configurado en las variables de entorno');
}

// Cliente de Pinecone
export const pineconeClient = new Pinecone({
  apiKey: PINECONE_API_KEY,
});

// Función de embedding usando OpenAI
export const embeddingModel = new OpenAIEmbeddings({
  openAIApiKey: OPENAI_API_KEY,
  modelName: 'text-embedding-3-small',
});

// Función de embedding en formato compatible con Pinecone
export const embeddingFunction = {
  generate: async (texts: string[]) => {
    const results = await Promise.all(
      texts.map(text => embeddingModel.embedQuery(text))
    );
    return results;
  }
};

// Función para obtener el índice
export async function getIndex() {
  try {
    // Verificar si el índice existe
    const indexList = await pineconeClient.listIndexes();
    
    // Verificar si el índice existe en la lista de índices
    const indexExists = indexList.indexes?.some(index => index.name === PINECONE_INDEX_NAME);
    
    if (!indexExists) {
      console.log(`El índice ${PINECONE_INDEX_NAME} no existe. Creando...`);
      // Crear el índice si no existe
      // Nota: La creación de índices puede tardar hasta 1-2 minutos
      await pineconeClient.createIndex({
        name: PINECONE_INDEX_NAME,
        dimension: 1536, // Dimensión para embeddings de OpenAI text-embedding-3-small
        metric: 'cosine',
        spec: {
          serverless: {
            cloud: 'gcp',
            region: 'us-central1'
          }
        }
      });
      
      console.log(`Índice ${PINECONE_INDEX_NAME} creado exitosamente.`);
    }
    
    // Obtener el índice
    const index = pineconeClient.index(PINECONE_INDEX_NAME);
    return index;
  } catch (error) {
    console.error('Error al obtener o crear el índice de Pinecone:', error);
    throw error;
  }
}

// Exportar constantes
export { PINECONE_INDEX_NAME };
