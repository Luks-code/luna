import { getIndex, embeddingModel } from './pineconeClient';
import * as path from 'path';
import * as fs from 'fs';

// Configuración
const MAX_RESULTS = 5;
const DOCUMENTS_DIR = path.resolve(__dirname, '../../data/documents/procesados');

// Función para consultar documentos similares
export async function queryDocuments(query: string, topK: number = MAX_RESULTS): Promise<any[]> {
  try {
    // Detectar consultas específicas sobre licencias de conducir y horarios
    if (isLicenseQuery(query)) {
      console.log('[RAG] Consulta específica sobre licencias de conducir detectada');
      return getLicenseDocuments(query);
    }
    
    // Preprocesar la consulta para mejorar la relevancia
    const processedQuery = preprocessQuery(query);
    console.log(`[RAG] Consulta original: "${query}"`);
    console.log(`[RAG] Consulta procesada: "${processedQuery}"`);
    
    // Generar embedding para la consulta
    const queryEmbedding = await embeddingModel.embedQuery(processedQuery);
    
    // Obtener el índice de Pinecone
    const index = await getIndex();
    
    // Realizar la consulta de similitud
    const queryResponse = await index.query({
      vector: queryEmbedding,
      topK: topK * 2, // Recuperar más resultados para filtrar después
      includeMetadata: true,
    });
    
    // Extraer y formatear los resultados
    let results = queryResponse.matches.map(match => ({
      score: match.score || 0,
      text: match.metadata?.text || '',
      source: match.metadata?.source || '',
      metadata: match.metadata || {},
    }));
    
    // Aplicar reranking para mejorar la relevancia
    const rerankedResults = await rerankResults(results, processedQuery);
    
    // Filtrar y ordenar resultados por relevancia
    results = filterAndRankResults(rerankedResults, processedQuery);
    
    // Limitar a topK resultados
    results = results.slice(0, topK);
    
    // Imprimir información sobre los resultados para depuración
    console.log(`[RAG] Se encontraron ${results.length} documentos relevantes:`);
    results.forEach((doc, i) => {
      const filename = doc.source ? path.basename(doc.source.toString()) : 'Desconocido';
      console.log(`[RAG] Documento ${i+1}: ${filename} (Score: ${doc.score})`);
    });
    
    return results;
  } catch (error) {
    console.error('Error al consultar documentos:', error);
    return [];
  }
}

// Función para detectar consultas específicas sobre licencias de conducir
function isLicenseQuery(query: string): boolean {
  const licenseKeywords = ['licencia', 'conducir', 'manejar', 'carnet', 'registro'];
  const horarioKeywords = ['horario', 'hora', 'atención', 'cuando', 'atienden'];
  
  const lowerQuery = query.toLowerCase();
  
  // Verificar si la consulta contiene palabras clave de licencias y horarios
  const hasLicenseKeyword = licenseKeywords.some(keyword => lowerQuery.includes(keyword));
  const hasHorarioKeyword = horarioKeywords.some(keyword => lowerQuery.includes(keyword));
  
  return hasLicenseKeyword && (hasHorarioKeyword || lowerQuery.includes('donde') || lowerQuery.includes('requisito'));
}

// Función para obtener documentos específicos sobre licencias de conducir
async function getLicenseDocuments(query: string): Promise<any[]> {
  try {
    // Buscar el archivo de licencias de conducir
    const files = fs.readdirSync(DOCUMENTS_DIR);
    const licenseFile = files.find(f => f.toLowerCase().includes('licencia'));
    
    if (!licenseFile) {
      console.log('[RAG] No se encontró el archivo de licencias de conducir');
      // Si no se encuentra, usar el flujo normal
      return queryDocuments(query, MAX_RESULTS);
    }
    
    // Leer el contenido del archivo
    const filePath = path.join(DOCUMENTS_DIR, licenseFile);
    const content = fs.readFileSync(filePath, 'utf-8');
    
    console.log(`[RAG] Se encontró el archivo de licencias: ${licenseFile}`);
    
    // Crear un resultado con el contenido del archivo
    const result = {
      score: 1.0, // Máxima puntuación
      text: content,
      source: filePath,
      metadata: {
        source: filePath,
        text: content
      }
    };
    
    return [result];
  } catch (error) {
    console.error('Error al obtener documentos de licencias:', error);
    return [];
  }
}

// Función para preprocesar la consulta y mejorar la relevancia
function preprocessQuery(query: string): string {
  // Convertir a minúsculas
  let processedQuery = query.toLowerCase();
  
  // Identificar palabras clave importantes
  const keywordMap: {[key: string]: string[]} = {
    'licencia': ['licencia', 'conducir', 'manejar', 'carnet', 'registro'],
    'horario': ['horario', 'hora', 'atención', 'atienden', 'abierto'],
    'ubicación': ['donde', 'ubicación', 'dirección', 'lugar', 'oficina'],
    'requisitos': ['requisitos', 'necesito', 'documentos', 'papeles', 'trámite']
  };
  
  // Verificar si la consulta contiene palabras clave
  let enhancedQuery = processedQuery;
  
  // Añadir términos relevantes basados en las palabras clave detectadas
  for (const [category, keywords] of Object.entries(keywordMap)) {
    if (keywords.some(keyword => processedQuery.includes(keyword))) {
      if (category === 'licencia' && !processedQuery.includes('licencia conducir')) {
        enhancedQuery = `licencia de conducir ${enhancedQuery}`;
      }
      if (category === 'horario' && !processedQuery.includes('horario licencia')) {
        enhancedQuery = `horario ${enhancedQuery}`;
      }
    }
  }
  
  return enhancedQuery;
}

// Función para reordenar los resultados basados en relevancia contextual
async function rerankResults(results: any[], query: string): Promise<any[]> {
  if (results.length <= 1) {
    return results; // No hay necesidad de reordenar si hay 0 o 1 resultado
  }

  console.log('[RAG] Aplicando reranking a los resultados...');
  
  try {
    // Factores para ajustar la puntuación
    const titleMatchBoost = 0.15;
    const keywordMatchBoost = 0.1;
    const lengthPenalty = 0.05;
    
    // Extraer palabras clave de la consulta (excluyendo palabras comunes)
    const stopWords = ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'de', 'del', 'a', 'para', 'por', 'con', 'en', 'que', 'es', 'son'];
    const queryWords = query.toLowerCase()
      .replace(/[.,?¿!¡;:()\[\]{}""'']/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.includes(word));
    
    // Reordenar resultados
    const rerankedResults = results.map(result => {
      let adjustedScore = result.score;
      const lowerText = result.text.toLowerCase();
      const metadata = result.metadata || {};
      
      // Boost por coincidencia en título/fuente
      if (result.source) {
        const source = result.source.toLowerCase();
        if (queryWords.some(word => source.includes(word))) {
          adjustedScore += titleMatchBoost;
        }
      }
      
      // Boost por coincidencia de palabras clave
      const keywordMatches = queryWords.filter(word => lowerText.includes(word)).length;
      const keywordMatchRatio = keywordMatches / queryWords.length;
      adjustedScore += keywordMatchRatio * keywordMatchBoost;
      
      // Penalización por longitud excesiva (favorece respuestas concisas)
      if (result.text.length > 1000) {
        adjustedScore -= lengthPenalty;
      }
      
      return {
        ...result,
        score: adjustedScore,
        originalScore: result.score // Mantener la puntuación original para referencia
      };
    });
    
    // Ordenar por puntuación ajustada
    rerankedResults.sort((a, b) => b.score - a.score);
    
    console.log(`[RAG] Reranking completado. Primer resultado score: ${rerankedResults[0].score.toFixed(3)} (original: ${rerankedResults[0].originalScore?.toFixed(3)})`);
    
    return rerankedResults;
  } catch (error) {
    console.error('[RAG] Error en reranking:', error);
    return results; // En caso de error, devolver los resultados originales
  }
}

// Función para filtrar y ordenar resultados por relevancia
function filterAndRankResults(results: any[], query: string): any[] {
  // Palabras clave para aumentar la relevancia
  const boostKeywords: {[key: string]: number} = {
    'licencia': 1.5,
    'conducir': 1.5,
    'horario': 1.3,
    'atención': 1.3,
    'requisitos': 1.2,
    'trámite': 1.2
  };
  
  // Calcular una puntuación personalizada para cada resultado
  return results
    .map(result => {
      let customScore = result.score;
      
      // Aumentar la puntuación si el nombre del archivo contiene palabras clave
      const filename = result.source ? path.basename(result.source.toString()).toLowerCase() : '';
      if (filename.includes('licencia') || filename.includes('conducir')) {
        customScore *= 2.0; // Dar mucho más peso a archivos específicos de licencias
      }
      
      // Aumentar la puntuación si el texto contiene palabras clave de la consulta
      const lowerText = result.text.toLowerCase();
      for (const [keyword, boost] of Object.entries(boostKeywords)) {
        if (query.includes(keyword) && lowerText.includes(keyword)) {
          customScore *= boost;
        }
      }
      
      return { ...result, customScore };
    })
    .sort((a, b) => b.customScore - a.customScore); // Ordenar por puntuación personalizada
}

// Función para formatear documentos para el contexto
export function formatDocumentsForContext(documents: any[]): string {
  if (!documents || documents.length === 0) {
    return "No se encontraron documentos relevantes.";
  }
  
  return documents.map((doc, i) => {
    const source = doc.source ? path.basename(doc.source.toString()) : 'Desconocida';
    return `Documento ${i+1} (Fuente: ${source}):\n${doc.text}`;
  }).join('\n\n');
}

// Función para obtener contexto relevante
export async function getRelevantContext(query: string, maxResults: number = MAX_RESULTS): Promise<string> {
  const docs = await queryDocuments(query, maxResults);
  return formatDocumentsForContext(docs);
}

// Función para ejecutar desde línea de comandos
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Uso: ts-node queryPinecone.ts <consulta>');
    process.exit(1);
  }
  
  const query = args.join(' ');
  
  queryDocuments(query)
    .then(results => {
      console.log(`Encontrados ${results.length} documentos relevantes para: "${query}"`);
      
      results.forEach((result, index) => {
        console.log(`\nRESULTADO ${index + 1} (Relevancia: ${Math.round(result.score * 100)}%):`);
        console.log(`Fuente: ${result.source}`);
        console.log(`Texto: ${result.text.substring(0, 200)}...`);
      });
    })
    .catch(console.error);
}
