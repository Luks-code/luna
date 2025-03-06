// Script para probar el enfoque "RAG primero"
import generateText from '../src/textGenerator';
import { ConversationState, IntentType, ConversationMessage } from '../src/types';

async function testRAGPrimero() {
  console.log('=== PRUEBA DE ENFOQUE "RAG PRIMERO" ===');
  
  // Crear un estado de conversación inicial
  const initialState: ConversationState = {
    isComplaintInProgress: false,
    currentIntent: IntentType.OTHER, // Usar OTHER en lugar de UNKNOWN
    complaintData: {
      type: undefined,
      description: undefined,
      location: undefined,
      citizenData: {
        name: undefined,
        documentId: undefined,
        address: undefined
      }
    },
    currentStep: 'INIT'
  };
  
  // Historial de mensajes vacío
  const messageHistory: ConversationMessage[] = [];
  
  // Consulta informativa sobre licencias
  const query1 = "¿Qué necesito para sacar la licencia de conducir?";
  console.log(`\n\nPRUEBA 1: Consulta informativa sobre licencias`);
  console.log(`Consulta: "${query1}"`);
  
  try {
    const response1 = await generateText(query1, initialState, messageHistory);
    console.log('Respuesta:');
    console.log(JSON.stringify(response1, null, 2));
    
    // Actualizar el historial de mensajes
    messageHistory.push({ 
      role: 'user', 
      content: query1,
      timestamp: Date.now()
    });
    messageHistory.push({ 
      role: 'assistant', 
      content: response1.message,
      timestamp: Date.now()
    });
    
    // Consulta de seguimiento
    const query2 = "¿Y cuál es el horario de atención?";
    console.log(`\n\nPRUEBA 2: Consulta de seguimiento sobre horarios`);
    console.log(`Consulta: "${query2}"`);
    
    const response2 = await generateText(query2, initialState, messageHistory);
    console.log('Respuesta:');
    console.log(JSON.stringify(response2, null, 2));
    
    // Actualizar el historial de mensajes
    messageHistory.push({ 
      role: 'user', 
      content: query2,
      timestamp: Date.now()
    });
    messageHistory.push({ 
      role: 'assistant', 
      content: response2.message,
      timestamp: Date.now()
    });
    
    // Consulta que podría interpretarse como reclamo
    const query3 = "Mi perro necesita ser castrado";
    console.log(`\n\nPRUEBA 3: Consulta que podría interpretarse como reclamo`);
    console.log(`Consulta: "${query3}"`);
    
    const response3 = await generateText(query3, initialState, messageHistory);
    console.log('Respuesta:');
    console.log(JSON.stringify(response3, null, 2));
    
    // Comando específico que no debería usar RAG
    const query4 = "Quiero hacer un reclamo por un bache";
    console.log(`\n\nPRUEBA 4: Comando específico que no debería usar RAG`);
    console.log(`Consulta: "${query4}"`);
    
    const response4 = await generateText(query4, initialState, messageHistory);
    console.log('Respuesta:');
    console.log(JSON.stringify(response4, null, 2));
    
  } catch (error) {
    console.error('Error durante la prueba:', error);
  }
}

// Ejecutar la prueba
testRAGPrimero().then(() => {
  console.log('\n=== PRUEBAS COMPLETADAS ===');
}).catch(error => {
  console.error('Error al ejecutar las pruebas:', error);
});
