import { getIndex, embeddingModel } from './pineconeClient';
import * as path from 'path';
import * as fs from 'fs';

// Configuración
const MAX_RESULTS = 5;
const DOCUMENTS_DIR = path.resolve(__dirname, '../../data/documents/procesados');

// Función para consultar documentos similares
export async function queryDocuments(query: string, topK: number = MAX_RESULTS): Promise<any> {
  try {
    // Detectar consultas específicas sobre licencias de conducir y horarios
    if (isLicenseQuery(query)) {
      console.log('[RAG] Consulta específica sobre licencias de conducir detectada');
      const licenseResults = await getLicenseDocuments(query);
      
      // Evaluar confianza en los resultados específicos de licencias
      const confidence = evaluateResultConfidence(licenseResults, query);
      return {
        results: licenseResults,
        confidence: confidence
      };
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
    
    // Evaluar la confianza en los resultados
    const confidence = evaluateResultConfidence(results, query);
    
    return {
      results: results,
      confidence: confidence
    };
  } catch (error) {
    console.error('Error al consultar documentos:', error);
    return {
      results: [],
      confidence: {
        confidence: 0,
        isReliable: false,
        reason: "Error al consultar documentos"
      }
    };
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
  
  // Mapa expandido de palabras clave por categoría
  const keywordMap: {[key: string]: string[]} = {
    'licencia': ['licencia', 'conducir', 'manejar', 'carnet', 'registro', 'brevete', 'permiso', 'conductor'],
    'horario': ['horario', 'hora', 'atención', 'atienden', 'abierto', 'cerrado', 'cuando', 'días', 'dias', 'abre', 'cierra'],
    'ubicación': ['donde', 'ubicación', 'dirección', 'lugar', 'oficina', 'sede', 'edificio', 'local', 'queda', 'ubicado'],
    'requisitos': ['requisitos', 'necesito', 'documentos', 'papeles', 'trámite', 'tramite', 'necesario', 'debo', 'llevar', 'presentar'],
    'mascotas': ['mascota', 'perro', 'gato', 'animal', 'castrar', 'castración', 'castracion', 'veterinario', 'veterinaria'],
    'residuos': ['basura', 'residuo', 'reciclaje', 'reciclar', 'recolección', 'recoleccion', 'separación', 'separar', 'desecho'],
    'impuestos': ['impuesto', 'tasa', 'pago', 'abonar', 'contribución', 'contribucion', 'tributo', 'fiscal', 'municipal'],
    'reclamos': ['reclamo', 'queja', 'denuncia', 'problema', 'inconveniente', 'solicitud', 'reportar'],
    'transito': ['tránsito', 'transito', 'multa', 'infracción', 'infraccion', 'vial', 'vialidad', 'tráfico', 'trafico', 'vehicular']
  };
  
  // Detectar categorías relevantes en la consulta
  const relevantCategories: string[] = [];
  for (const [category, keywords] of Object.entries(keywordMap)) {
    if (keywords.some(keyword => processedQuery.includes(keyword))) {
      relevantCategories.push(category);
    }
  }
  
  // Si no se detectaron categorías, devolver la consulta original
  if (relevantCategories.length === 0) {
    return processedQuery;
  }
  
  // Expandir la consulta con términos relevantes
  let enhancedQuery = processedQuery;
  
  // Añadir términos clave de las categorías detectadas
  relevantCategories.forEach(category => {
    // Evitar duplicar términos que ya están en la consulta
    const primaryTerm = keywordMap[category][0]; // Usar el primer término como principal
    if (!processedQuery.includes(primaryTerm)) {
      enhancedQuery = `${primaryTerm} ${enhancedQuery}`;
    }
  });
  
  // Detectar consultas específicas y añadir contexto
  
  // Caso especial para castraciones de mascotas - expansión agresiva
  if ((processedQuery.includes('castrar') || processedQuery.includes('castración') || processedQuery.includes('castracion')) && 
      (processedQuery.includes('mascota') || processedQuery.includes('perro') || processedQuery.includes('gato') || processedQuery.includes('animal'))) {
    
    // Forzar la inclusión de términos específicos para castraciones
    enhancedQuery = `castraciones castración requisitos mascota ${enhancedQuery}`;
    console.log(`[RAG] Expansión especial para consulta de castraciones: "${enhancedQuery}"`);
  } 
  // Caso general para requisitos
  else if (!processedQuery.includes('requisitos') && 
           (processedQuery.includes('necesito') || processedQuery.includes('debo') || 
            processedQuery.includes('cómo') || processedQuery.includes('como'))) {
    enhancedQuery = `requisitos ${enhancedQuery}`;
  }
  
  console.log(`[RAG] Consulta expandida: "${enhancedQuery}"`);
  return enhancedQuery;
}

// Función para reordenar los resultados basados en relevancia contextual
async function rerankResults(results: any[], query: string): Promise<any[]> {
  if (results.length <= 1) {
    return results; // No hay necesidad de reordenar si hay 0 o 1 resultado
  }

  console.log('[RAG] Aplicando reranking a los resultados...');
  
  try {
    // Factores para ajustar la puntuación (aumentados para dar más peso)
    const titleMatchBoost = 0.25; // Aumentado de 0.15
    const exactMatchBoost = 0.3; // Nuevo factor para coincidencias exactas
    const keywordMatchBoost = 0.2; // Aumentado de 0.1
    const contentDensityBoost = 0.15; // Nuevo factor para densidad de coincidencias
    const lengthPenalty = 0.05;
    
    // Extraer palabras clave de la consulta (excluyendo palabras comunes)
    const stopWords = ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'de', 'del', 'a', 'para', 'por', 'con', 'en', 'que', 'es', 'son', 'mi', 'tu', 'su', 'me', 'te', 'se', 'nos', 'le', 'les', 'hay'];
    const queryWords = query.toLowerCase()
      .replace(/[.,?¿!¡;:()\[\]{}""'']/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.includes(word));
    
    // Extraer frases clave (2-3 palabras consecutivas)
    const queryPhrases: string[] = [];
    for (let i = 0; i < queryWords.length - 1; i++) {
      queryPhrases.push(`${queryWords[i]} ${queryWords[i+1]}`);
      if (i < queryWords.length - 2) {
        queryPhrases.push(`${queryWords[i]} ${queryWords[i+1]} ${queryWords[i+2]}`);
      }
    }
    
    // Palabras clave críticas para ciertos temas
    const criticalKeywords: {[key: string]: string[]} = {
      'castrar': ['castracion', 'castraciones', 'castración'],
      'mascota': ['mascota', 'mascotas', 'perro', 'gato', 'animal'],
      'licencia': ['licencia', 'licencias', 'conducir', 'carnet'],
      'residuo': ['residuo', 'residuos', 'basura', 'reciclaje']
    };
    
    // Detectar palabras clave críticas en la consulta
    const detectedCriticalKeywords: string[] = [];
    for (const [key, keywords] of Object.entries(criticalKeywords)) {
      if (keywords.some(kw => query.toLowerCase().includes(kw))) {
        detectedCriticalKeywords.push(key);
      }
    }
    
    // Reordenar resultados
    const rerankedResults = results.map(result => {
      let adjustedScore = result.score;
      const lowerText = result.text.toLowerCase();
      const metadata = result.metadata || {};
      
      // 1. Boost por coincidencia en título/fuente (mejorado)
      if (result.source) {
        const filename = path.basename(result.source.toString()).toLowerCase();
        
        // Boost mayor si hay coincidencia exacta de palabras clave en el nombre del archivo
        const filenameWords = filename
          .replace(/[._-]/g, ' ')
          .split(/\s+/)
          .filter(word => word.length > 2);
        
        const filenameMatchCount = queryWords.filter(word => 
          filenameWords.some(fileWord => fileWord.includes(word) || word.includes(fileWord))
        ).length;
        
        if (filenameMatchCount > 0) {
          const filenameMatchRatio = filenameMatchCount / queryWords.length;
          const filenameBoost = titleMatchBoost * filenameMatchRatio * 2; // Doble boost por coincidencia en nombre de archivo
          adjustedScore += filenameBoost;
          console.log(`[RAG] Boost por nombre de archivo (${filename}): +${filenameBoost.toFixed(3)}`);
        }
        
        // Boost adicional para coincidencias exactas con palabras clave críticas
        for (const criticalKeyword of detectedCriticalKeywords) {
          if (filename.includes(criticalKeyword)) {
            const criticalBoost = 0.4; // Boost muy alto para coincidencias críticas
            adjustedScore += criticalBoost;
            console.log(`[RAG] Boost por coincidencia crítica en archivo (${criticalKeyword}): +${criticalBoost.toFixed(3)}`);
          }
        }
        
        // Caso especial para castraciones
        if ((query.toLowerCase().includes('castrar') || query.toLowerCase().includes('castración') || query.toLowerCase().includes('castracion')) &&
            (filename.includes('castracion') || filename.includes('castraciones'))) {
          const specialBoost = 0.5; // Boost extremadamente alto para este caso específico
          adjustedScore += specialBoost;
          console.log(`[RAG] Boost especial para documento de castraciones: +${specialBoost.toFixed(3)}`);
        }
      }
      
      // 2. Boost por coincidencia exacta de frases
      const exactMatches = queryPhrases.filter(phrase => lowerText.includes(phrase)).length;
      if (exactMatches > 0) {
        const exactMatchScore = exactMatchBoost * (exactMatches / queryPhrases.length);
        adjustedScore += exactMatchScore;
      }
      
      // 3. Boost por coincidencia de palabras clave (mejorado)
      const keywordMatches = queryWords.filter(word => lowerText.includes(word)).length;
      const keywordMatchRatio = keywordMatches / queryWords.length;
      const keywordBoost = keywordMatchRatio * keywordMatchBoost;
      adjustedScore += keywordBoost;
      
      // 4. Boost por densidad de contenido relevante
      // Calcula qué tan concentradas están las palabras clave en el texto
      if (keywordMatches > 0 && lowerText.length > 0) {
        const contentDensity = (keywordMatches * 100) / (lowerText.length / 10); // Normalizado por longitud
        const densityBoost = Math.min(contentDensityBoost, contentDensityBoost * (contentDensity / 10));
        adjustedScore += densityBoost;
      }
      
      // 5. Penalización por longitud excesiva (favorece respuestas concisas)
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

// Función para evaluar la confianza en los resultados de RAG
export function evaluateResultConfidence(results: any[], query: string): { 
  confidence: number, 
  isReliable: boolean,
  reason: string 
} {
  if (!results || results.length === 0) {
    return { 
      confidence: 0, 
      isReliable: false,
      reason: 'No se encontraron documentos relevantes' 
    };
  }
  
  // Inicializar con un valor base
  let confidence = 0.45; // Valor base reducido para ser más estrictos
  
  // Factores que afectan la confianza
  const factors: {factor: string, impact: number, description: string}[] = [];
  
  // 1. Evaluar la puntuación del mejor resultado
  const topScore = results[0].score;
  if (topScore < 0.2) {
    factors.push({
      factor: 'score_bajo',
      impact: -0.25, // Aumentado el impacto negativo
      description: 'El mejor resultado tiene una similitud baja con la consulta'
    });
  } else if (topScore > 0.7) {
    factors.push({
      factor: 'score_alto',
      impact: 0.15,
      description: 'El mejor resultado tiene una alta similitud con la consulta'
    });
  }
  
  // 2. Evaluar la diferencia entre el mejor y el segundo mejor resultado
  if (results.length > 1) {
    const scoreDifference = results[0].score - results[1].score;
    if (scoreDifference < 0.1) {
      factors.push({
        factor: 'diferencia_pequeña',
        impact: -0.15, // Aumentado el impacto negativo
        description: 'No hay un resultado claramente dominante'
      });
    } else if (scoreDifference > 0.3) {
      factors.push({
        factor: 'resultado_dominante',
        impact: 0.25,
        description: 'Hay un resultado claramente superior a los demás'
      });
    }
  }
  
  // 3. Evaluar la presencia de palabras clave de la consulta en el documento
  const queryWords = query.toLowerCase()
    .replace(/[.,?¿!¡;:()\[\]{}""'']/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2);
  
  const topResultText = results[0].text.toLowerCase();
  const keywordMatches = queryWords.filter(word => topResultText.includes(word)).length;
  const keywordMatchRatio = keywordMatches / queryWords.length;
  
  if (keywordMatchRatio < 0.3) {
    factors.push({
      factor: 'keywords_faltantes',
      impact: -0.2, // Aumentado el impacto negativo
      description: 'El documento no contiene suficientes palabras clave de la consulta'
    });
  } else if (keywordMatchRatio > 0.7) {
    factors.push({
      factor: 'keywords_alta_coincidencia',
      impact: 0.15,
      description: 'El documento contiene la mayoría de las palabras clave de la consulta'
    });
  }
  
  // 4. Evaluar si la consulta es sobre una categoría específica
  const categories: {[key: string]: string[]} = {
    'licencias': ['licencia', 'conducir', 'carnet', 'manejar', 'brevete'],
    'mascotas': ['mascota', 'perro', 'gato', 'animal', 'castrar', 'castración', 'castracion', 'veterinario'],
    'residuos': ['basura', 'residuo', 'reciclaje', 'reciclar', 'separar', 'separación'],
    'transito': ['tránsito', 'transito', 'multa', 'infracción', 'vial'],
    'salud': ['salud', 'médico', 'medico', 'hospital', 'clínica', 'clinica', 'policlínica', 'policlinica']
  };
  
  let detectedCategories: string[] = [];
  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.some((kw: string) => query.toLowerCase().includes(kw))) {
      detectedCategories.push(category);
    }
  }
  
  // 5. Verificar si el título/nombre del documento coincide con la categoría detectada
  if (detectedCategories.length > 0) {
    const filename = path.basename(results[0].source.toString()).toLowerCase();
    const titleWords = filename.replace(/[._-]/g, ' ').split(/\s+/);
    
    let categoryInTitle = false;
    for (const category of detectedCategories) {
      if (titleWords.some(word => {
        const categoryKeywords = categories[category as keyof typeof categories];
        return categoryKeywords.some((kw: string) => word.includes(kw) || kw.includes(word));
      })) {
        categoryInTitle = true;
        factors.push({
          factor: 'categoria_en_titulo',
          impact: 0.25,
          description: `El título del documento coincide con la categoría '${category}' de la consulta`
        });
        break;
      }
    }
    
    // Si la categoría está en el contenido pero no en el título, impacto menor
    if (!categoryInTitle) {
      const contentHasCategory = detectedCategories.some(category => 
        categories[category].some(kw => topResultText.includes(kw))
      );
      
      if (contentHasCategory) {
        factors.push({
          factor: 'categoria_coincidente',
          impact: 0.2,
          description: 'La categoría de la consulta coincide con el contenido del documento'
        });
      } else {
        factors.push({
          factor: 'categoria_sin_coincidencia',
          impact: -0.2,
          description: 'La categoría de la consulta no coincide con el contenido del documento'
        });
      }
    }
  }
  
  // 6. Evaluar la relevancia del título
  if (results[0].metadata && results[0].metadata.title) {
    const title = results[0].metadata.title.toLowerCase();
    const titleKeywordMatches = queryWords.filter(word => title.includes(word)).length;
    if (titleKeywordMatches > 0) {
      const titleRelevanceImpact = Math.min(0.2, 0.08 * titleKeywordMatches);
      factors.push({
        factor: 'titulo_relevante',
        impact: titleRelevanceImpact,
        description: `El título del documento coincide con ${titleKeywordMatches} términos clave de la consulta`
      });
    }
  }
  
  // 7. Evaluar la densidad de palabras clave en el documento
  if (keywordMatches > 0 && topResultText.length > 0) {
    const contentDensity = (keywordMatches * 100) / (topResultText.length / 10);
    if (contentDensity > 5) {
      factors.push({
        factor: 'alta_densidad_keywords',
        impact: 0.1, // Reducido el impacto positivo
        description: 'Alta concentración de palabras clave en el documento'
      });
    }
  }
  
  // 8. Verificar si es una consulta sobre servicios municipales específicos
  if (isMunicipalServiceQuery(query)) {
    // Para servicios municipales, ser más flexible con la confianza
    confidence += 0.1;
  }
  
  // 9. Caso especial para castraciones
  if (query.toLowerCase().includes('castrar') || query.toLowerCase().includes('castración') || query.toLowerCase().includes('castracion')) {
    const filename = path.basename(results[0].source.toString()).toLowerCase();
    if (filename.includes('castracion') || filename.includes('castraciones')) {
      factors.push({
        factor: 'documento_castraciones',
        impact: 0.3,
        description: 'Documento específico sobre castraciones'
      });
    }
  }
  
  // 10. Verificar si la consulta es sobre una ubicación específica
  const locationKeywords = ['donde', 'ubicación', 'ubicacion', 'dirección', 'direccion', 'lugar', 'queda'];
  if (locationKeywords.some(kw => query.toLowerCase().includes(kw))) {
    // Para consultas de ubicación, ser más estrictos con la confianza
    // Verificar si el documento realmente contiene información de ubicación
    const locationPatterns = [
      /\b(ubicad[oa]s?\s+en|dirección|direccion|se\s+encuentra\s+en|queda\s+en)\b.*?\b(calle|avenida|av\.|ruta|esquina|intersección|barrio)\b/i,
      /\b(calle|avenida|av\.|ruta)\s+[A-Za-z\s]+\b\s*,?\s*\d+/i,
      /\b(barrio|b°)\s+[A-Za-z\s]+\b/i
    ];
    
    const containsLocationInfo = locationPatterns.some(pattern => pattern.test(topResultText));
    
    if (!containsLocationInfo) {
      factors.push({
        factor: 'sin_info_ubicacion',
        impact: -0.3, // Fuerte impacto negativo
        description: 'El documento no contiene información de ubicación específica'
      });
    } else {
      factors.push({
        factor: 'contiene_ubicacion',
        impact: 0.2,
        description: 'El documento contiene información de ubicación'
      });
    }
  }
  
  // 11. Verificar si la consulta es sobre un servicio específico que no está en la base de datos
  const specificServiceKeywords = ['policlínica', 'policlinica', 'hospital', 'biblioteca'];
  if (specificServiceKeywords.some(kw => query.toLowerCase().includes(kw))) {
    // Verificar si el documento realmente menciona ese servicio específico
    const serviceInQuery = specificServiceKeywords.find(kw => query.toLowerCase().includes(kw));
    
    if (serviceInQuery && !topResultText.toLowerCase().includes(serviceInQuery)) {
      factors.push({
        factor: 'servicio_no_mencionado',
        impact: -0.4, // Impacto negativo muy fuerte
        description: `El documento no menciona el servicio específico '${serviceInQuery}'`
      });
    }
  }
  
  // Aplicar todos los factores a la confianza base
  for (const factor of factors) {
    confidence += factor.impact;
  }
  
  // Asegurar que la confianza esté en el rango [0, 1]
  confidence = Math.max(0, Math.min(1, confidence));
  
  // Determinar si la información es confiable (umbral más estricto)
  const isReliable = confidence >= 0.6; // Aumentado el umbral de confianza
  
  // Determinar la razón principal de la confianza o desconfianza
  let reason = '';
  if (factors.length > 0) {
    // Ordenar factores por impacto absoluto (de mayor a menor)
    const sortedFactors = [...factors].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
    reason = sortedFactors[0].description;
  } else {
    reason = 'No hay factores significativos que afecten la confianza';
  }
  
  console.log(`[RAG] Evaluación de confianza: ${confidence.toFixed(2)} (${isReliable ? 'Confiable' : 'No confiable'})`);
  console.log(`[RAG] Factores que afectaron la confianza:`, JSON.stringify(factors, null, 2));
  
  return {
    confidence,
    isReliable,
    reason
  };
}

// Función auxiliar para detectar si la consulta es sobre servicios municipales específicos
function isMunicipalServiceQuery(query: string): boolean {
  const municipalServiceKeywords = [
    'castración', 'castracion', 'castrar', 'mascota', 'licencia', 'conducir', 
    'residuos', 'basura', 'reciclaje', 'impuesto', 'tasa', 'trámite', 'tramite',
    'discapacidad', 'transito', 'tránsito', 'feria', 'artesanos', 'ecocanje'
  ];
  
  const queryLower = query.toLowerCase();
  return municipalServiceKeywords.some(keyword => queryLower.includes(keyword));
}

// Función para ejecutar desde línea de comandos
if (require.main === module) {
  const args = process.argv.slice(2);
  const query = args.join(' ') || 'licencia de conducir';
  
  queryDocuments(query)
    .then(results => {
      console.log(`Encontrados ${results.results.length} documentos relevantes para: "${query}"`);
      
      results.results.forEach((result: any, index: number) => {
        console.log(`\nRESULTADO ${index + 1} (Relevancia: ${Math.round(result.score * 100)}%):`);
        console.log(`Fuente: ${result.source}`);
        console.log(`Texto: ${result.text.substring(0, 200)}...`);
      });
      
      console.log(`\nConfianza en los resultados: ${results.confidence.confidence.toFixed(2)} (${results.confidence.isReliable ? 'Confiable' : 'No confiable'})`);
      console.log(`Razón: ${results.confidence.reason}`);
    })
    .catch(console.error);
}
