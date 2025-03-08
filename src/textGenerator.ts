// textGenerator.ts
import openai from './openai';
import { GPTResponse, ConversationState, ConversationMessage, IntentType, ConversationMode } from './types';
import { ComplaintTypes } from './prisma';
import { ChatCompletionMessageParam } from 'openai/resources/chat';
import { queryDocuments, formatDocumentsForContext, getRelevantContext } from './rag/queryPinecone';

// Función para extraer el tema principal de una consulta
function extractMainTopic(message: string): string | null {
  const lowercaseMessage = message.toLowerCase();
  
  // Lista de temas municipales comunes
  const municipalTopics = [
    { keywords: ['habilitación', 'habilitacion', 'comercial', 'negocio', 'local'], topic: 'habilitaciones_comerciales' },
    { keywords: ['impuesto', 'tasa', 'tributo', 'pago', 'abl', 'municipal'], topic: 'impuestos_municipales' },
    { keywords: ['obra', 'construcción', 'construccion', 'edificación', 'edificacion', 'permiso'], topic: 'obras_particulares' },
    { keywords: ['trámite', 'tramite', 'gestión', 'gestion', 'documento'], topic: 'tramites_municipales' },
    { keywords: ['servicio', 'municipal', 'público', 'publico'], topic: 'servicios_municipales' },
    { keywords: ['reclamo', 'queja', 'denuncia'], topic: 'reclamos' }
  ];
  
  // Buscar coincidencias con temas municipales
  for (const { keywords, topic } of municipalTopics) {
    if (keywords.some(keyword => lowercaseMessage.includes(keyword))) {
      return topic;
    }
  }
  
  return null;
}

// Función para formatear el historial de mensajes
function formatMessageHistory(messageHistory: ConversationMessage[]): string {
  if (!messageHistory || messageHistory.length === 0) {
    return "No hay mensajes previos.";
  }
  
  return messageHistory.map(msg => {
    return `${msg.role === 'user' ? 'Usuario' : 'Asistente'}: ${msg.content}`;
  }).join('\n');
}

// Función para llamar a la API de OpenAI con un prompt
async function callOpenAI(prompt: string): Promise<GPTResponse> {
  try {
    // Construir el mensaje del sistema
    const apiMessages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: prompt
      }
    ];

    // Llamar a la API
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: apiMessages,
      response_format: { type: 'json_object' },
      max_tokens: 10000,
      temperature: 0.4,  // Ligero aumento para mejorar completitud
      presence_penalty: 0.1,  // Añadir para evitar repeticiones
      frequency_penalty: 0.1,  // Añadir para mejorar diversidad
    });

    // Parsear y devolver la respuesta
    return JSON.parse(
      response.choices[0]?.message?.content || '{}'
    ) as GPTResponse;
  } catch (error) {
    console.error('Error al llamar a OpenAI:', error);
    return {
      isComplaint: false,
      message: 'Lo siento, ha ocurrido un error. Por favor, intenta nuevamente.',
    };
  }
}

// Función para generar respuesta con RAG
async function generateResponseWithRAG(message: string, conversationState: ConversationState, messageHistory: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[RAG] Iniciando generación de respuesta con RAG');
  try {
    // Si el mensaje es corto y parece ser una continuación, buscar en el historial
    // para determinar el contexto de la consulta anterior
    let queryToUse = message;
    
    if (message.length < 30 && messageHistory.length >= 2) {
      // Buscar la última consulta del usuario y respuesta del asistente
      const recentMessages = messageHistory.slice(-4); // Últimos 4 mensajes
      
      // Extraer consultas anteriores del usuario
      const previousUserQueries = recentMessages
        .filter(msg => msg.role === 'user')
        .map(msg => msg.content);
      
      // Si hay consultas anteriores, usarlas para enriquecer el contexto
      if (previousUserQueries.length > 0) {
        const previousQuery = previousUserQueries[previousUserQueries.length - 1];
        console.log(`[RAG] Consulta actual parece ser continuación. Consulta anterior: "${previousQuery}"`);
        queryToUse = `${previousQuery} ${message}`;
      }
    }
    
    console.log(`[RAG] Consulta a utilizar para búsqueda: "${queryToUse}"`);
    
    // 1. Buscar documentos relevantes
    console.log('[RAG] Buscando documentos relevantes...');
    const relevantDocs = await queryDocuments(queryToUse, 5);
    
    // 2. Si no hay resultados relevantes, usar el flujo normal
    if (relevantDocs.length === 0) {
      console.log('[RAG] No se encontraron documentos relevantes, usando flujo normal');
      return generateStandardResponse(message, conversationState, messageHistory);
    }
    
    // 3. Preparar el contexto con la información recuperada
    console.log(`[RAG] Preparando contexto con ${relevantDocs.length} documentos relevantes`);
    const context = formatDocumentsForContext(relevantDocs);
    
    // 4. Generar la respuesta incluyendo el contexto
    console.log('[RAG] Generando respuesta con contexto enriquecido');
    const systemPrompt = getSystemPrompt(conversationState);
    
    // 5. Construir el prompt completo con el contexto de los documentos y recordatorios adicionales
    const fullPrompt = `${systemPrompt}

### RECORDATORIO IMPORTANTE:
- SIEMPRE proporciona TODOS los detalles relevantes en el campo "message"
- NUNCA respondas con frases como "¿Quieres que te dé más detalles?" o "¿Te gustaría que te los detalle?"
- INCLUYE TODA LA INFORMACIÓN DISPONIBLE en los documentos relevantes
- Si el usuario pregunta por requisitos, horarios, ubicaciones o procedimientos, DEBES incluir TODOS esos detalles en tu respuesta

### INFORMACIÓN RELEVANTE DE LA BASE DE CONOCIMIENTO:
${context}

### Historial de conversación:
${formatMessageHistory(messageHistory)}

### Estado actual:
${JSON.stringify(conversationState, null, 2)}

### Mensaje del usuario:
${message}

### Genera una respuesta:`;
    
    // 6. Llamar a la API de OpenAI con el contexto enriquecido
    const response = await callOpenAI(fullPrompt);
    console.log('[RAG] Respuesta generada exitosamente usando RAG');
    
    return response;
  } catch (error) {
    console.error('[RAG] Error al generar respuesta con RAG:', error);
    // En caso de error, usar el flujo estándar como fallback
    console.log('[RAG] Usando flujo estándar como fallback debido al error');
    return generateStandardResponse(message, conversationState, messageHistory);
  }
}

// Función para verificar si todos los datos del reclamo están completos
function isComplaintDataComplete(state: ConversationState): boolean {
  if (!state.isComplaintInProgress || !state.complaintData) {
    return false;
  }
  
  const data = state.complaintData;
  return !!(
    data.type && 
    data.description && 
    data.location && 
    data.citizenData?.name && 
    data.citizenData?.documentId && 
    data.citizenData?.address
  );
}

// Función para verificar si se ha solicitado confirmación
function hasRequestedConfirmation(state: ConversationState): boolean {
  return !!state.confirmationRequested;
}

// Función para generar respuesta estándar
async function generateStandardResponse(message: string, state: ConversationState, history: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Generando respuesta estándar');
  
  // Verificar si todos los datos del reclamo están completos y no se ha solicitado confirmación aún
  const complaintComplete = isComplaintDataComplete(state);
  const confirmationRequested = hasRequestedConfirmation(state);
  
  // Si el reclamo está completo y no se ha solicitado confirmación, forzar la solicitud
  if (complaintComplete && !confirmationRequested && !message.toLowerCase().includes('confirmar') && !message.toLowerCase().includes('cancelar')) {
    console.log('[Luna] Reclamo completo detectado, solicitando confirmación explícita');
    
    // Crear un resumen de los datos del reclamo
    const complaintData = state.complaintData!;
    const complaintSummary = `
Tipo de reclamo: ${complaintData.type}
Descripción: ${complaintData.description}
Ubicación: ${complaintData.location}
Nombre: ${complaintData.citizenData?.name}
DNI: ${complaintData.citizenData?.documentId}
Dirección: ${complaintData.citizenData?.address}
    `;
    
    // Actualizar el estado para indicar que se ha solicitado confirmación
    state.confirmationRequested = true;
    state.awaitingConfirmation = true; // Sincronizar ambos flags
    
    // Devolver una respuesta que solicite confirmación explícita
    return {
      isComplaint: true,
      message: `He recopilado todos los datos necesarios para tu reclamo. Aquí está el resumen:\n${complaintSummary.trim()}\n\nPor favor, responde únicamente CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo.`,
      data: state.complaintData
    };
  }
  
  // Si el mensaje es "CONFIRMAR" y todos los datos están completos
  if (message.toLowerCase() === 'confirmar' && complaintComplete) {
    console.log('[Luna] Confirmación recibida para reclamo completo');
    
    // Aquí se procesaría el guardado del reclamo (en la implementación actual esto lo maneja otro componente)
    
    // Resetear el estado de confirmación para futuros reclamos
    state.confirmationRequested = false;
    state.awaitingConfirmation = false; // Sincronizar ambos flags
    
    return {
      isComplaint: true,
      message: "¡Gracias! Tu reclamo ha sido registrado exitosamente. Te notificaremos cuando haya novedades. ¿Hay algo más en lo que pueda ayudarte?",
      data: state.complaintData
    };
  }
  
  // Si el mensaje es "CANCELAR" y se había solicitado confirmación
  if (message.toLowerCase() === 'cancelar' && confirmationRequested) {
    console.log('[Luna] Cancelación recibida para reclamo');
    
    // Resetear el estado de confirmación
    state.confirmationRequested = false;
    state.awaitingConfirmation = false; // Sincronizar ambos flags
    
    return {
      isComplaint: false,
      message: "He cancelado el registro del reclamo. Todos los datos ingresados han sido descartados. ¿Puedo ayudarte con algo más?"
    };
  }
  
  // Para otros casos, continuar con el flujo normal
  const prompt = `
${getSystemPrompt(state)}

### Historial de conversación:
${formatMessageHistory(history)}

### Estado actual:
${JSON.stringify(state, null, 2)}

### Mensaje del usuario:
${message}

### Genera una respuesta:`;
  
  return await callOpenAI(prompt);
}

// Función para detectar múltiples reclamos en un mensaje
function detectMultipleComplaints(message: string): boolean {
  // Patrones que podrían indicar múltiples problemas
  const multipleComplaintPatterns = [
    // Enumeraciones
    /\b(1|primero|primer)\b.*\b(2|segundo|también|tambien|además|ademas)\b/i,
    // Conectores que indican adición
    /\b(además|ademas|también|tambien)\b.*\b(problema|reclamo|queja|issue)\b/i,
    // Múltiples ubicaciones
    /\b(en la calle|en la esquina|en la avenida|en el barrio)\b.*\b(también|tambien|además|ademas|y)\b.*\b(en la calle|en la esquina|en la avenida|en el barrio)\b/i,
    // Múltiples tipos de problemas
    /\b(luz|alumbrado|poste|luminaria)\b.*\b(basura|residuos|escombros|agua|cloacas|pavimento)\b/i,
    // Separadores explícitos
    /\b(por un lado|por otro lado|por otra parte)\b/i,
    // Múltiples problemas explícitos
    /\b(varios problemas|diferentes problemas|distintos problemas|dos problemas|múltiples problemas|multiples problemas)\b/i
  ];
  
  // Verificar si alguno de los patrones coincide con el mensaje
  return multipleComplaintPatterns.some(pattern => pattern.test(message));
}

// Función para validar la completitud de una respuesta
function validateResponseCompleteness(response: GPTResponse): boolean {
  const message = response.message;
  
  // Patrones que sugieren respuestas incompletas
  const incompletePatterns = [
    /\.\.\.$/, // Termina con puntos suspensivos
    /entre otros/i, // Usa "entre otros" en lugar de listar todo
    /etc\.?$/i, // Usa "etc." al final
    /para más información/i, // Promete más información pero no la da
    /los requisitos son:/i, // Introduce requisitos pero no los lista todos
    /los pasos son:/i, // Introduce pasos pero no los lista todos
    /más detalles/i, // Sugiere que hay más detalles sin darlos
  ];
  
  // Verificar si hay patrones de incompletitud
  const hasIncompletePatterns = incompletePatterns.some(pattern => pattern.test(message));
  if (hasIncompletePatterns) {
    return false;
  }
  
  // Verificar si el mensaje termina con una pregunta o indicación clara
  const questionPatterns = [
    /\?$/, // Termina con signo de interrogación
    /qué (?:opinas|piensas|te parece)/i, // Pide opinión
    /(?:puedes|podrías) (?:decirme|indicarme|proporcionarme)/i, // Solicita información
    /(?:necesitas|quieres) (?:más información|ayuda|saber)/i, // Ofrece ayuda
    /responde (?:confirmar|cancelar)/i, // Solicita confirmación específica
    /(?:escribe|envía|usa) (?:\/[a-z]+)/i, // Sugiere usar un comando
  ];
  
  // Verificar si el mensaje termina con alguna forma de pregunta o indicación
  const lastSentences = message.split(/[.!?]\s+/).slice(-2).join(' '); // Últimas dos oraciones
  const hasQuestion = questionPatterns.some(pattern => pattern.test(lastSentences));
  
  return hasQuestion;
}

// Función para generar texto
export async function generateText(message: string, conversationState?: ConversationState, messageHistory?: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Generando respuesta para mensaje:', message);
  try {
    // Asegurarse de que los parámetros opcionales tengan valores por defecto
    const state = conversationState || {} as ConversationState;
    const history = messageHistory || [];
    
    // Verificar si es un comando específico que no debería usar RAG
    const isCommand = isSpecificCommand(message);
    
    // Si estamos esperando confirmación, manejar directamente
    if (state.confirmationRequested && state.awaitingConfirmation) {
      console.log('[Luna] Esperando confirmación, procesando respuesta directamente');
      
      // Normalizar el mensaje para comparación
      const normalizedMessage = message.toLowerCase().trim();
      
      if (normalizedMessage === 'confirmar') {
        return {
          isComplaint: true,
          message: "¡Gracias! Tu reclamo ha sido registrado exitosamente. Te notificaremos cuando haya novedades. ¿Hay algo más en lo que pueda ayudarte?",
          data: state.complaintData
        };
      } else if (normalizedMessage === 'cancelar') {
        return {
          isComplaint: false,
          message: "He cancelado el registro del reclamo. Todos los datos ingresados han sido descartados. ¿Puedo ayudarte con algo más?"
        };
      } else {
        // Cualquier otra entrada no es válida
        return {
          isComplaint: true,
          message: "Por favor, responde únicamente CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo.",
          data: state.complaintData
        };
      }
    }
    
    let response: GPTResponse;
    
    // Procesar según el modo actual
    if (state.mode === ConversationMode.COMPLAINT || state.isComplaintInProgress) {
      console.log('[Luna] Procesando en modo COMPLAINT');
      response = await processComplaintMode(message, state, history);
    } else if (state.mode === ConversationMode.INFO) {
      console.log('[Luna] Procesando en modo INFO');
      response = await processInfoMode(message, state, history);
    } else if (isCommand) {
      console.log('[Luna] Procesando comando específico');
      response = await generateStandardResponse(message, state, history);
    } else {
      console.log('[Luna] Procesando en modo DEFAULT');
      response = await processDefaultMode(message, state, history);
    }
    
    // Validar la completitud de la respuesta
    if (!validateResponseCompleteness(response)) {
      console.log('[Luna] Respuesta detectada como incompleta, intentando completarla...');
      
      // Añadir instrucción específica para completar
      const followupPrompt = `
${getSystemPrompt(state)}

### RECORDATORIO IMPORTANTE:
- La respuesta anterior parece estar incompleta. 
- DEBES completarla asegurándote de incluir TODA la información relevante.
- NUNCA dejes información a medias.
- Si estás enumerando requisitos o pasos, LISTA TODOS ellos.
- EVITA frases como "entre otros" o "etc." - sé específico y exhaustivo.

### Respuesta incompleta anterior:
${response.message}

### Historial de conversación:
${formatMessageHistory(history)}

### Estado actual:
${JSON.stringify(state, null, 2)}

### Mensaje del usuario:
${message}

### Genera una respuesta COMPLETA y DETALLADA:`;
      
      // Intentar generar una respuesta más completa
      const completedResponse = await callOpenAI(followupPrompt);
      
      // Usar la respuesta mejorada si parece más completa
      if (completedResponse.message && completedResponse.message.length > response.message.length) {
        console.log('[Luna] Se ha generado una respuesta más completa');
        response = completedResponse;
      }
    }
    
    return response;
  } catch (error) {
    console.error('[Luna] Error al generar texto:', error);
    return {
      isComplaint: false,
      message: "Lo siento, estoy teniendo problemas para procesar tu mensaje. ¿Podrías intentarlo de nuevo o reformularlo?"
    };
  }
}

// Procesador para el modo de reclamos
async function processComplaintMode(message: string, state: ConversationState, history: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Procesando mensaje en modo COMPLAINT');
  
  // Detectar si el mensaje parece una consulta informativa
  if (isLikelyInformationQuery(message) && !state.awaitingConfirmation && !state.confirmationRequested) {
    console.log('[Luna] Mensaje detectado como consulta informativa mientras estaba en modo COMPLAINT');
    
    // Guardar el modo anterior
    state.previousMode = state.mode;
    
    // Cambiar temporalmente al modo INFO
    state.mode = ConversationMode.INFO;
    
    // Reiniciar la bandera de mensaje de cambio de modo para que se muestre el mensaje de cambio a INFO
    state.modeChangeMessageSent = false;
    
    // Marcar como flujo interrumpido para poder volver después
    if (!state.interruptedFlow) {
      state.interruptedFlow = true;
      state.interruptionContext = {
        originalIntent: IntentType.COMPLAINT,
        resumePoint: state.currentStep
      };
    }
    
    // Procesar como consulta informativa
    return await processInfoMode(message, state, history);
  }
  
  // Verificar si todos los datos del reclamo están completos y no se ha solicitado confirmación aún
  const complaintComplete = isComplaintDataComplete(state);
  const confirmationRequested = hasRequestedConfirmation(state);
  
  // Si el reclamo está completo y no se ha solicitado confirmación, forzar la solicitud
  if (complaintComplete && !confirmationRequested && !message.toLowerCase().includes('confirmar') && !message.toLowerCase().includes('cancelar')) {
    console.log('[Luna] Reclamo completo detectado, solicitando confirmación explícita');
    
    // Crear un resumen de los datos del reclamo
    const complaintData = state.complaintData!;
    const complaintSummary = `
Tipo de reclamo: ${complaintData.type}
Descripción: ${complaintData.description}
Ubicación: ${complaintData.location}
Nombre: ${complaintData.citizenData?.name}
DNI: ${complaintData.citizenData?.documentId}
Dirección: ${complaintData.citizenData?.address}
    `;
    
    // Actualizar el estado para indicar que se ha solicitado confirmación
    state.confirmationRequested = true;
    state.awaitingConfirmation = true; // Sincronizar ambos flags
    
    // Devolver una respuesta que solicite confirmación explícita
    return {
      isComplaint: true,
      message: `He recopilado todos los datos necesarios para tu reclamo. Aquí está el resumen:\n${complaintSummary.trim()}\n\nPor favor, responde únicamente CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo.`,
      data: state.complaintData
    };
  }
  
  // Para otros casos, usar el flujo estándar
  return await generateStandardResponse(message, state, history);
}

// Procesador para el modo de información
async function processInfoMode(message: string, state: ConversationState, history: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Procesando mensaje en modo INFO');
  
  try {
    // En el modo INFO, siempre intentamos usar RAG primero
    let response: GPTResponse;
    
    // Forzar el uso de RAG para consultas informativas, independientemente del estado del reclamo
    try {
      console.log('[Luna] Intentando usar RAG para consulta informativa');
      response = await generateResponseWithRAG(message, state, history);
    } catch (error) {
      console.error('[INFO] Error al generar respuesta con RAG, usando flujo estándar:', error);
      response = await generateStandardResponse(message, state, history);
    }
    
    // Si estábamos en modo COMPLAINT y cambiamos temporalmente a INFO, volver al modo COMPLAINT
    if (state.previousMode === ConversationMode.COMPLAINT && state.isComplaintInProgress) {
      console.log('[Luna] Volviendo al modo COMPLAINT después de responder a consulta informativa');
      
      // Volver al modo COMPLAINT
      state.mode = ConversationMode.COMPLAINT;
      
      // No reiniciar la bandera modeChangeMessageSent para evitar mostrar nuevamente el mensaje de cambio a modo COMPLAINT
      state.modeChangeMessageSent = true;
      
      // Agregar un recordatorio sobre el reclamo en progreso, pero solo si la respuesta no es muy larga
      if (response.message.length < 500) {
        response.message += "\n\nRecuerda que tienes un reclamo en progreso. ¿Deseas continuar con él o necesitas ayuda con algo más?";
      }
    }
    
    return response;
  } catch (error) {
    console.error('[INFO] Error general en processInfoMode:', error);
    const response = await generateStandardResponse(message, state, history);
    
    // Si estábamos en modo COMPLAINT y cambiamos temporalmente a INFO, volver al modo COMPLAINT
    if (state.previousMode === ConversationMode.COMPLAINT && state.isComplaintInProgress) {
      console.log('[Luna] Volviendo al modo COMPLAINT después de responder a consulta informativa');
      
      // Volver al modo COMPLAINT
      state.mode = ConversationMode.COMPLAINT;
      
      // No reiniciar la bandera modeChangeMessageSent para evitar mostrar nuevamente el mensaje de cambio a modo COMPLAINT
      state.modeChangeMessageSent = true;
      
      // Agregar un recordatorio sobre el reclamo en progreso, pero solo si la respuesta no es muy larga
      if (response.message.length < 500) {
        response.message += "\n\nRecuerda que tienes un reclamo en progreso. ¿Deseas continuar con él o necesitas ayuda con algo más?";
      }
    }
    
    return response;
  }
}

// Procesador para el modo por defecto
async function processDefaultMode(message: string, state: ConversationState, history: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Procesando mensaje en modo DEFAULT');
  
  // Detectar múltiples reclamos
  const hasMultipleComplaints = detectMultipleComplaints(message);
  
  // Si se detectan múltiples reclamos y no hay uno en progreso, informar al usuario
  if (hasMultipleComplaints && !state.isComplaintInProgress) {
    console.log('[Luna] Múltiples reclamos detectados, solicitando al usuario que los procese uno por uno');
    
    return {
      isComplaint: true,
      message: "He detectado que mencionas varios problemas diferentes. Para poder ayudarte mejor, necesito que procesemos un reclamo a la vez. Por favor, indícame cuál de los problemas mencionados te gustaría registrar primero. ¿Cuál es el problema principal que deseas reportar en este momento?",
      data: {
        type: "MULTIPLE"
      }
    };
  }
  
  // Detectar si el mensaje parece un reclamo
  const complaintKeywords = [
    'reclamo', 'queja', 'problema', 'falla', 'arreglar', 'roto', 'dañado', 
    'no funciona', 'mal estado', 'denunciar', 'reportar'
  ];
  
  const lowerMessage = message.toLowerCase();
  const isLikelyComplaint = complaintKeywords.some(keyword => lowerMessage.includes(keyword));
  
  // Si parece un reclamo y no hay uno en progreso, cambiar al modo de reclamo
  if (isLikelyComplaint && !state.isComplaintInProgress) {
    console.log('[Luna] Mensaje detectado como posible reclamo, cambiando a modo COMPLAINT');
    state.mode = ConversationMode.COMPLAINT;
    state.isComplaintInProgress = true;
    
    // Inicializar datos del reclamo
    state.complaintData = {
      type: undefined,
      description: message,  // Usar el mensaje como descripción inicial
      location: undefined,
      citizenData: {
        name: undefined,
        documentId: undefined,
        address: undefined
      }
    };
    
    return await processComplaintMode(message, state, history);
  }
  
  // Para mensajes en modo DEFAULT, verificamos si debemos usar RAG según los criterios
  try {
    if (shouldUseRAG(message, state)) {
      return await generateResponseWithRAG(message, state, history);
    } else {
      // Si no es apropiado usar RAG, usamos el flujo estándar
      return await generateStandardResponse(message, state, history);
    }
  } catch (error) {
    console.error('[DEFAULT] Error al generar respuesta con RAG:', error);
    return await generateStandardResponse(message, state, history);
  }
}

// Función para verificar si es un comando específico
function isSpecificCommand(message: string): boolean {
  // Palabras clave que indican comandos específicos que no deberían usar RAG
  const commandKeywords = [
    'cancelar', 'cancel',
    'ayuda', 'help',
    'estado', 'status',
    'reiniciar', 'restart',
    'confirmar', 'confirm',
    'misreclamos', 'myrequests',
    'reclamo', 'request'
  ];
  
  // Si el mensaje contiene palabras clave de comandos, es un comando específico
  const lowercaseMessage = message.toLowerCase();
  const isCommand = commandKeywords.some(keyword => lowercaseMessage.includes(keyword));
  
  if (isCommand) {
    console.log('[Luna] Detectado comando específico:', message);
  }
  
  return isCommand;
}

// Función para determinar si se debe usar RAG para un mensaje
function shouldUseRAG(message: string, state: ConversationState): boolean {
  // 1. Priorizar el modo INFO - Usar RAG si estamos en modo INFO (este modo está específicamente diseñado para consultas informativas)
  if (state.mode === ConversationMode.INFO) {
    console.log('[Luna] Usando RAG porque estamos en modo INFO');
    return true;
  }
  
  // 2. No usar RAG si hay un reclamo en progreso en modo COMPLAINT
  if (state.isComplaintInProgress && state.mode === ConversationMode.COMPLAINT) {
    console.log('[Luna] No usando RAG porque hay un reclamo en progreso en modo COMPLAINT');
    return false;
  }
  
  // 3. No usar RAG para saludos simples y mensajes muy cortos no informativos
  const lowercaseMessage = message.toLowerCase().trim();
  const simpleGreetings = [
    'hola', 'buenos días', 'buenas tardes', 'buenas noches', 
    'hi', 'hello', 'hey', 'saludos', 'buen día', 'qué tal'
  ];
  
  if (simpleGreetings.some(greeting => lowercaseMessage === greeting)) {
    console.log('[Luna] No usando RAG para un saludo simple');
    return false;
  }
  
  // 4. Para todos los demás casos, permitir que GPT-4o-mini determine si necesita información adicional
  // Esto proporciona flexibilidad mientras evita usar RAG en casos obvios donde no es necesario
  console.log('[Luna] Permitiendo que el modelo determine si necesita información adicional');
  return true;
}

// Función para obtener el prompt del sistema basado en el estado actual
function getSystemPrompt(conversationState: ConversationState): string {
  // Determinar el modo actual
  const mode = conversationState.mode || ConversationMode.DEFAULT;
  
  // Base común del prompt
  const basePrompt = `# INSTRUCCIONES PARA ASISTENTE MUNICIPAL LUNA

Eres Nina, un asistente virtual de la Municipalidad de Tafí Viejo, Tucumán, Argentina.

# FORMATO DE RESPUESTA
- Tus respuestas deben ser concisas, claras y amigables.
- SIEMPRE termina tus mensajes con una pregunta clara o indicación sobre qué debe responder el usuario.
- Incluye TODA la información relevante en el campo "message", incluyendo la pregunta final.
- NO uses el campo "nextQuestion" (está obsoleto).
- Si estás recolectando datos para un reclamo, asegúrate de que el usuario sepa exactamente qué información necesitas a continuación.

# COMANDOS DISPONIBLES
- /ayuda - Muestra todos los comandos disponibles
- /estado - Muestra el estado del reclamo actual
- /cancelar - Cancela el reclamo en curso
- /reiniciar - Comienza una nueva conversación
- /confirmar - Guarda el reclamo cuando se solicite
- /misreclamos - Muestra todos tus reclamos anteriores
- /reclamo <número> - Muestra los detalles de un reclamo específico
- /info - Cambia al modo de información
- /consulta - Cambia al modo de información
`;

  // Instrucciones específicas según el modo
  let modeSpecificPrompt = '';
  
  if (mode === ConversationMode.COMPLAINT || conversationState.isComplaintInProgress) {
    modeSpecificPrompt = `
# MODO ACTUAL: RECLAMOS
Tu función principal es ayudar a los ciudadanos a registrar reclamos municipales.

# MANEJO DE RECLAMOS
Debes recolectar la siguiente información en este orden:
1. Tipo de reclamo (identificar de la conversación)
2. Descripción detallada del problema
3. Ubicación exacta del problema (dirección donde se encuentra el problema)
4. Nombre completo del ciudadano
5. Número de DNI
6. Dirección del ciudadano (donde vive el ciudadano)

# DISTINCIÓN ENTRE UBICACIÓN DEL PROBLEMA Y DIRECCIÓN DEL CIUDADANO
- La "ubicación" (location) se refiere a DÓNDE ESTÁ EL PROBLEMA que se reporta (ej: "El poste de luz está en Av. Aconquija y Bascary")
- La "dirección" (address) se refiere a DÓNDE VIVE EL CIUDADANO que hace el reclamo (ej: "Vivo en Perú 489, Tafí Viejo")
- Usa términos claros para diferenciar:
  * Para location: "ubicación del problema", "lugar del incidente", "dirección donde se encuentra el problema"
  * Para address: "tu dirección de residencia", "dirección donde vives", "domicilio del ciudadano"
- NUNCA uses simplemente "dirección" sin especificar a cuál te refieres

# INSTRUCCIONES CRÍTICAS
- SIEMPRE incluye una pregunta específica al final de tu mensaje, NUNCA uses el campo "nextQuestion".
- SIEMPRE menciona los comandos que puede utilizar el usuario cuando sea necesario.
- NUNCA des por terminada la conversación hasta que todos los datos estén completos
- Recolecta UN DATO A LA VEZ, no pidas múltiples datos en una misma pregunta
- Si ya tienes el tipo de reclamo, pregunta por la descripción detallada
- Si ya tienes la descripción, pregunta por la ubicación exacta
- Si ya tienes la ubicación, pregunta por el nombre completo
- Si ya tienes el nombre, pregunta por el DNI
- Si ya tienes el DNI, pregunta por la dirección
- Cuando tengas todos los datos, solicita confirmación

# TIPOS DE RECLAMOS DISPONIBLES
${Object.entries(ComplaintTypes)
  .map(([key, value]) => `   - ${key}: ${value}`)
  .join('\n')}
`;
  } else if (mode === ConversationMode.INFO) {
    modeSpecificPrompt = `
# MODO ACTUAL: INFORMACIÓN
Tu función principal es proporcionar información detallada sobre servicios, trámites y temas municipales.

# INSTRUCCIONES PARA RESPONDER CONSULTAS INFORMATIVAS
- Proporciona respuestas DETALLADAS y COMPLETAS basadas en la información de los documentos
- SIEMPRE INCLUYE TODOS LOS DATOS RELEVANTES en el campo "message", nunca los omitas.
- Incluye TODOS los datos relevantes como requisitos, procedimientos, horarios, ubicaciones, etc.
- Estructura tu respuesta de manera clara con secciones si es necesario
- No omitas información importante por brevedad
- Si la información en los documentos es técnica, explícala en términos sencillos
- SIEMPRE utiliza toda la información relevante de los documentos para dar una respuesta completa
- Cuando respondas sobre trámites o procedimientos, incluye TODOS los pasos necesarios
- Si hay requisitos específicos, enuméralos TODOS
- Si no encuentras información específica sobre la consulta, indícalo claramente y ofrece alternativas
- NUNCA respondas con "¿Te gustaría que te los detalle?" o frases similares en el campo "message" - SE PROACTIVO, MENCIONA LOS DETALLES SIN ESPERAR A QUE EL USUARIO LOS PREGUNTE.
- SIEMPRE aclara que tú información puede no ser actualizada o puede no ser 100% precisa, y que lo mejor es que se contacten con la municipalidad o accedan a su sitio web. 
`;
  } else {
    // Modo DEFAULT
    modeSpecificPrompt = `
# MODO ACTUAL: GENERAL
Puedes ayudar tanto con reclamos como con consultas informativas.

# MANEJO DE RECLAMOS
Si el usuario menciona un problema o reclamo, debes recolectar la siguiente información en este orden:
1. Tipo de reclamo (identificar de la conversación)
2. Descripción detallada del problema
3. Ubicación exacta del problema (dirección donde se encuentra el problema)
4. Nombre completo del ciudadano
5. Número de DNI
6. Dirección del ciudadano (donde vive el ciudadano)

# DISTINCIÓN ENTRE UBICACIÓN DEL PROBLEMA Y DIRECCIÓN DEL CIUDADANO
- La "ubicación" (location) se refiere a DÓNDE ESTÁ EL PROBLEMA que se reporta (ej: "El poste de luz está en Av. Aconquija y Bascary")
- La "dirección" (address) se refiere a DÓNDE VIVE EL CIUDADANO que hace el reclamo (ej: "Vivo en Perú 489, Tafí Viejo")

# INSTRUCCIONES PARA RESPONDER CONSULTAS INFORMATIVAS
- Proporciona respuestas DETALLADAS y COMPLETAS basadas en la información de los documentos
- SIEMPRE INCLUYE TODOS LOS DATOS RELEVANTES en el campo "message", nunca los omitas.
- Incluye TODOS los datos relevantes como requisitos, procedimientos, horarios, ubicaciones, etc.
- SIEMPRE utiliza toda la información relevante de los documentos para dar una respuesta completa
- Cuando respondas sobre trámites o procedimientos, incluye TODOS los pasos necesarios
- Si hay requisitos específicos, enuméralos TODOS
- NUNCA respondas con "¿Te gustaría que te los detalle?" o frases similares - SE PROACTIVO, MENCIONA LOS DETALLES SIN ESPERAR A QUE EL USUARIO LOS PREGUNTE.
`;
  }

  // Ejemplos de respuestas correctas
  const examplesPrompt = `
# EJEMPLOS DE RESPUESTAS CORRECTAS

## Ejemplo 1: Inicio de conversación
Usuario: "Hola, ¿cómo estás?"
Asistente: 
message: "¡Hola! 👋 Soy Nina, la asistente virtual de la Municipalidad de Tafí Viejo. Estoy aquí para ayudarte a registrar reclamos o resolver tus dudas sobre servicios municipales. ¿En qué puedo ayudarte hoy?"

## Ejemplo 2: Consulta informativa
Usuario: "¿Qué necesito para sacar la licencia de conducir?"
Asistente:
message: "Para obtener la licencia de conducir en Tafí Viejo necesitas:

• Fotocopia y original de DNI
• Certificado de Grupo Sanguíneo
• Libre Deuda Municipal
• Abonar la tasa correspondiente

Solicita un turno de atención en Av. Raya y Carbajal, Lomas de Tafí. El horario de atención es de 8 a 13 horas.

¿Necesitas información sobre algún otro trámite municipal?"

## Ejemplo 3: Inicio de reclamo
Usuario: "Hay un poste de luz caído en mi calle"
Asistente:
message: "Entiendo que quieres reportar un problema con el alumbrado público. He registrado que hay un poste de luz caído. Para continuar con tu reclamo, ¿podrías proporcionarme más detalles sobre la ubicación exacta donde se encuentra el poste caído?"

## Ejemplo 4: Recolección de datos - Ubicación
Usuario: "Está en la esquina de Aconquija y Bascary"
Asistente:
message: "Gracias por la información. He registrado que el poste de luz caído se encuentra en la esquina de Avenida Aconquija y Bascary. Para continuar con tu reclamo, necesito tus datos personales. ¿Podrías proporcionarme tu nombre completo?"

## Ejemplo 5: Recolección de datos - Nombre
Usuario: "Me llamo Juan Pérez"
Asistente:
message: "Gracias Juan. He registrado tu nombre. Para continuar con el reclamo, necesito tu número de DNI. ¿Podrías proporcionármelo?"

## Ejemplo 6: Recolección de datos - DNI
Usuario: "Mi DNI es 32456789"
Asistente:
message: "Gracias por proporcionar tu DNI. Para finalizar con los datos necesarios para tu reclamo, necesito tu dirección de residencia (donde vives). ¿Podrías indicarme cuál es tu domicilio?"

## Ejemplo 7: Recolección de datos - Dirección
Usuario: "Vivo en Perú 489, Tafí Viejo"
Asistente:
message: "Gracias por proporcionar tu dirección. He registrado todos los datos necesarios para tu reclamo:

• Tipo: Alumbrado Público
• Descripción: Poste de luz caído
• Ubicación del problema: Esquina de Avenida Aconquija y Bascary
• Nombre: Juan Pérez
• DNI: 32456789
• Dirección de residencia: Perú 489, Tafí Viejo

Por favor, responde CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo."

## Ejemplo 8: Interrupción durante reclamo
Usuario: "¿Cuánto tarda en resolverse?"
Asistente:
message: "Los reclamos de alumbrado público suelen resolverse en un plazo de 3 a 5 días hábiles, dependiendo de la complejidad del problema y la disponibilidad de materiales.

Volvamos a tu reclamo anterior. Estábamos registrando un problema de poste de luz caído en la esquina de Avenida Aconquija y Bascary. ¿Deseas continuar con el registro del reclamo?"

## Ejemplo 9: Confirmación
Usuario: "CONFIRMAR"
Asistente:
message: "✅ Reclamo registrado exitosamente!
Número de reclamo: #123
Tipo: Alumbrado Público
Estado: Pendiente de revisión

La conversación será reiniciada. ¿En qué más puedo ayudarte?"

## Ejemplo 10: Comandos
Usuario: "¿Cómo veo mis reclamos?"
Asistente:
message: "Para ver tus reclamos anteriores, puedes usar el comando /misreclamos. ¿Necesitas ayuda con algo más?"

Debes responder en formato JSON con la siguiente estructura:
{
  "isComplaint": boolean,
  "message": string (mensaje conversacional para el usuario, siempre debe terminar con una instrucción clara o pregunta)
  "data": {
    "type": string,
    "description": string,
    "location": string,
    "citizenData": {
      "name": string,
      "documentId": string,
      "address": string
    }
  }
}
`;

  // Combinar todas las partes del prompt
  return `${basePrompt}${modeSpecificPrompt}${examplesPrompt}`;
}

// Exportar la función por defecto para compatibilidad con código existente
export default generateText;

// Función para verificar si un reclamo está listo para guardar
export function isReadyToSave(complaintData: any): boolean {
  console.log('Verificando si el reclamo está listo para guardar:', JSON.stringify(complaintData, null, 2));
  
  // Verificar que todos los campos requeridos estén presentes y no estén vacíos
  if (!complaintData) {
    console.log('No hay datos de reclamo');
    return false;
  }

  const hasType = !!complaintData.type && complaintData.type.trim() !== '';
  const hasDescription = !!complaintData.description && complaintData.description.trim() !== '';
  const hasLocation = !!complaintData.location && complaintData.location.trim() !== '';
  
  const hasCitizenData = !!complaintData.citizenData;
  const hasName = hasCitizenData && !!complaintData.citizenData.name && complaintData.citizenData.name.trim() !== '';
  const hasDocumentId = hasCitizenData && !!complaintData.citizenData.documentId && complaintData.citizenData.documentId.trim() !== '';
  const hasAddress = hasCitizenData && !!complaintData.citizenData.address && complaintData.citizenData.address.trim() !== '';
  
  // Logging detallado para facilitar la depuración
  console.log('Verificación de campos:');
  console.log(`- Tipo: ${hasType ? 'OK' : 'FALTA'}`);
  console.log(`- Descripción: ${hasDescription ? 'OK' : 'FALTA'}`);
  console.log(`- Ubicación: ${hasLocation ? 'OK' : 'FALTA'}`);
  console.log(`- Datos del ciudadano: ${hasCitizenData ? 'OK' : 'FALTA'}`);
  console.log(`- Nombre: ${hasName ? 'OK' : 'FALTA'}`);
  console.log(`- DNI: ${hasDocumentId ? 'OK' : 'FALTA'}`);
  console.log(`- Dirección: ${hasAddress ? 'OK' : 'FALTA'}`);
  
  // Todos los campos deben estar presentes y no vacíos
  const isReady = hasType && hasDescription && hasLocation && hasName && hasDocumentId && hasAddress;
  console.log(`Reclamo listo para guardar: ${isReady ? 'SÍ' : 'NO'}`);
  
  return isReady;
}

// Función para detectar si un mensaje parece una consulta informativa
function isLikelyInformationQuery(message: string): boolean {
  // Palabras clave que indican una consulta informativa
  const infoKeywords = [
    'dónde', 'donde', 'cómo', 'como', 'cuándo', 'cuando', 'qué', 'que', 'cuál', 'cual',
    'horario', 'ubicación', 'ubicacion', 'dirección', 'direccion', 'requisitos', 'trámite', 'tramite',
    'información', 'informacion', 'consulta', 'ayuda', 'servicio', 'oficina', 'teléfono', 'telefono',
    'email', 'correo', 'contacto', 'precio', 'costo', 'tarifa', 'documento', 'formulario'
  ];
  
  const lowerMessage = message.toLowerCase();
  
  // Verificar si el mensaje contiene alguna de las palabras clave
  return infoKeywords.some(keyword => lowerMessage.includes(keyword));
}
