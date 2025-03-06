import { OpenAIEmbeddings } from '@langchain/openai';
import * as dotenv from 'dotenv';
import { getIndex, PINECONE_INDEX_NAME, pineconeClient } from '../src/rag/pineconeClient';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

// Configuración
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Función para probar la conexión a Pinecone
async function testPineconeConnection() {
  try {
    console.log('Probando conexión a Pinecone...');
    
    // Listar índices
    const indexList = await pineconeClient.listIndexes();
    console.log('Índices disponibles:', indexList);
    
    // Verificar si el índice existe
    const indexExists = indexList.indexes?.some(index => index.name === PINECONE_INDEX_NAME);
    console.log(`¿El índice ${PINECONE_INDEX_NAME} existe?`, indexExists);
    
    return true;
  } catch (error) {
    console.error('Error al conectar con Pinecone:', error);
    return false;
  }
}

// Función para probar la creación de embeddings
async function testEmbeddings() {
  try {
    console.log('Probando generación de embeddings...');
    
    // Inicializar embeddings
    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: OPENAI_API_KEY,
      modelName: 'text-embedding-3-small',
    });
    
    // Generar embedding para un texto de prueba
    const text = 'Este es un texto de prueba para generar embeddings con OpenAI.';
    const embedding = await embeddings.embedQuery(text);
    
    console.log(`Embedding generado con éxito. Dimensión: ${embedding.length}`);
    console.log('Primeros 5 valores:', embedding.slice(0, 5));
    
    return true;
  } catch (error) {
    console.error('Error al generar embeddings:', error);
    return false;
  }
}

// Función para probar la inserción en Pinecone
async function testPineconeUpsert() {
  try {
    console.log('Probando inserción en Pinecone...');
    
    // Obtener índice
    const index = await getIndex();
    
    // Inicializar embeddings
    const embeddings = new OpenAIEmbeddings({
      openAIApiKey: OPENAI_API_KEY,
      modelName: 'text-embedding-3-small',
    });
    
    // Generar embedding para un texto de prueba
    const text = 'Este es un texto de prueba para insertar en Pinecone.';
    const embedding = await embeddings.embedQuery(text);
    
    // Crear un ID único
    const id = `test_${uuidv4()}`;
    
    // Metadata de prueba
    const metadata = {
      source: 'test',
      text: text
    };
    
    // Insertar en Pinecone
    console.log('Insertando vector en Pinecone...');
    const upsertResponse = await index.upsert([{
      id: id,
      values: embedding,
      metadata: metadata
    }]);
    
    console.log('Respuesta de upsert:', upsertResponse);
    
    // Consultar el vector insertado
    console.log('Consultando vector insertado...');
    const queryResponse = await index.query({
      vector: embedding,
      topK: 1,
      includeMetadata: true
    });
    
    console.log('Respuesta de query:', queryResponse);
    
    return true;
  } catch (error) {
    console.error('Error al insertar en Pinecone:', error);
    console.error('Detalles del error:', JSON.stringify(error, null, 2));
    return false;
  }
}

// Función principal
async function main() {
  console.log('=== INICIANDO PRUEBAS DE PINECONE ===');
  
  // Probar conexión
  const connectionOk = await testPineconeConnection();
  if (!connectionOk) {
    console.error('La conexión a Pinecone falló. Abortando pruebas.');
    return;
  }
  
  // Probar embeddings
  const embeddingsOk = await testEmbeddings();
  if (!embeddingsOk) {
    console.error('La generación de embeddings falló. Abortando pruebas.');
    return;
  }
  
  // Probar inserción
  const upsertOk = await testPineconeUpsert();
  if (!upsertOk) {
    console.error('La inserción en Pinecone falló.');
    return;
  }
  
  console.log('=== TODAS LAS PRUEBAS COMPLETADAS CON ÉXITO ===');
}

// Ejecutar si se llama directamente
if (require.main === module) {
  main().catch(console.error);
}
