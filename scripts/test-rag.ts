import { queryDocuments } from '../src/rag/query';
import { IntentType, ConversationState, ComplaintData } from '../src/types';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Script para probar el sistema RAG integrado con el generador de texto
 * Uso: ts-node scripts/test-rag.ts "¿Cuáles son los requisitos para obtener una habilitación comercial?"
 */
async function testRAGIntegration() {
  // Obtener la consulta de los argumentos de línea de comandos
  const query = process.argv[2];
  
  if (!query) {
    console.error('Por favor proporciona una consulta. Ejemplo: ts-node scripts/test-rag.ts "¿Cómo obtener una habilitación comercial?"');
    process.exit(1);
  }
  
  console.log('='.repeat(80));
  console.log(`PRUEBA DE RECUPERACIÓN DE DOCUMENTOS RAG`);
  console.log('='.repeat(80));
  console.log(`Consulta: "${query}"`);
  console.log('-'.repeat(80));
  
  try {
    // Crear un estado de conversación simulado para pruebas
    const conversationState: ConversationState = {
      isComplaintInProgress: false,
      complaintData: {} as ComplaintData,
      currentStep: 'INIT',
      awaitingConfirmation: false,
      currentIntent: IntentType.INQUIRY
    };
    
    // Simular el proceso de detección de RAG
    console.log('[RAG] Evaluando si se debe usar RAG para la consulta...');
    
    // Palabras clave que sugieren una consulta informativa
    const informationKeywords = [
      'cómo', 'como', 'qué', 'que', 'cuál', 'cual', 'cuándo', 'cuando',
      'dónde', 'donde', 'quién', 'quien', 'por qué', 'porque', 'para qué',
      'requisitos', 'trámite', 'tramite', 'información', 'informacion',
      'horario', 'dirección', 'direccion', 'teléfono', 'telefono',
      'documento', 'formulario', 'solicitud', 'procedimiento'
    ];
    
    // Verificar si el mensaje contiene palabras clave informativas
    const lowercaseMessage = query.toLowerCase();
    const containsInfoKeyword = informationKeywords.some(keyword => lowercaseMessage.includes(keyword));
    
    console.log(`[RAG] ¿Contiene palabras clave informativas? ${containsInfoKeyword}`);
    
    if (containsInfoKeyword) {
      console.log('[RAG] Se usará RAG para generar la respuesta');
      
      // Buscar documentos relevantes
      console.log('[RAG] Buscando documentos relevantes...');
      const relevantDocs = await queryDocuments(query, 3);
      
      if (relevantDocs.length === 0) {
        console.log('[RAG] No se encontraron documentos relevantes');
      } else {
        console.log(`[RAG] Se encontraron ${relevantDocs.length} documentos relevantes:`);
        
        // Mostrar los documentos recuperados
        relevantDocs.forEach((doc, i) => {
          console.log(`\n--- Documento ${i+1} ---`);
          console.log(`Fuente: ${doc.metadata?.source || 'Desconocida'}`);
          console.log(`Relevancia: ${doc.score ? (1 - doc.score).toFixed(4) : 'N/A'}`);
          console.log(`\nContenido (primeros 200 caracteres):`);
          console.log('-'.repeat(80));
          console.log(doc.content.substring(0, 200) + (doc.content.length > 200 ? '...' : ''));
          console.log('-'.repeat(80));
        });
        
        console.log('\n[RAG] Estos documentos serían utilizados para generar una respuesta contextualizada');
      }
    } else {
      console.log('[RAG] No se usará RAG para esta consulta, se utilizaría el flujo estándar');
    }
    
  } catch (error) {
    console.error('Error al ejecutar la prueba:', error);
    process.exit(1);
  }
}

// Ejecutar la prueba
testRAGIntegration();
