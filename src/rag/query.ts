import { getCollection } from './chromaClient';
import * as dotenv from 'dotenv';

dotenv.config();

// Configuración
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Interfaz para los resultados de la consulta
export interface QueryResult {
  content: string;
  metadata?: {
    source?: string;
    [key: string]: any;
  };
  score?: number;
}

/**
 * Consulta documentos relevantes en ChromaDB basado en una consulta
 * @param query Texto de la consulta
 * @param limit Número máximo de resultados a devolver
 * @returns Array de resultados con contenido, metadatos y puntuación
 */
export async function queryDocuments(query: string, limit: number = 3): Promise<QueryResult[]> {
  console.log(`[RAG] Consultando documentos para: "${query}"`);
  try {
    // Obtener la colección
    const collection = await getCollection();
    console.log(`[RAG] Colección obtenida: ${collection.name}`);
    
    // Ejecutar la consulta
    console.log(`[RAG] Ejecutando consulta con límite de ${limit} resultados...`);
    const results = await collection.query({
      queryTexts: [query],
      nResults: limit
    });
    
    // Procesar los resultados
    if (!results.documents || results.documents.length === 0 || !results.documents[0] || results.documents[0].length === 0) {
      console.log('[RAG] No se encontraron documentos relevantes');
      return [];
    }
    
    // Extraer documentos, metadatos y distancias
    const documents = results.documents[0];
    const metadatas = results.metadatas && results.metadatas[0] ? results.metadatas[0] : [];
    const distances = results.distances && results.distances[0] ? results.distances[0] : [];
    
    console.log(`[RAG] Se encontraron ${documents.length} documentos relevantes`);
    
    // Crear array de resultados
    const queryResults = documents.map((doc, i) => {
      const metadata = metadatas[i] || {};
      const distance = distances[i] || null;
      
      // Calcular una puntuación de relevancia (1 - distancia)
      // Menor distancia = mayor relevancia
      const relevanceScore = distance !== null ? distance : null;
      
      // Registrar información sobre el documento recuperado
      if (metadata.source) {
        console.log(`[RAG] Documento ${i+1}: ${metadata.source} (Relevancia: ${relevanceScore ? relevanceScore.toFixed(4) : 'N/A'})`);
      } else {
        console.log(`[RAG] Documento ${i+1}: Fuente desconocida (Relevancia: ${relevanceScore ? relevanceScore.toFixed(4) : 'N/A'})`);
      }
      
      return {
        content: doc || '',
        metadata: metadata,
        score: relevanceScore
      } as QueryResult;
    });
    
    return queryResults;
  } catch (error) {
    console.error('[RAG] Error al consultar documentos:', error);
    return [];
  }
}

// Script para pruebas si se ejecuta directamente
if (require.main === module) {
  const query = process.argv[2] || '¿Cómo obtener una habilitación comercial?';
  
  queryDocuments(query)
    .then(results => {
      console.log(`Resultados para: "${query}"`);
      results.forEach((result, i) => {
        console.log(`\n--- Resultado ${i+1} ---`);
        console.log(`Fuente: ${result.metadata?.source || 'Desconocida'}`);
        if (result.metadata?.page) console.log(`Página: ${result.metadata.page}`);
        console.log(`Score: ${result.score !== undefined ? result.score : 'N/A'}`);
        console.log(`\nContenido:\n${result.content}`);
      });
    })
    .catch(err => console.error('Error:', err));
}
