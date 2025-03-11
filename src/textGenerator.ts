// textGenerator.ts
import openai from './openai';
import { GPTResponse, ConversationState, ConversationMessage, IntentType, ConversationMode } from './types';
import { ComplaintTypes } from './prisma';
import { ChatCompletionMessageParam } from 'openai/resources/chat';
import { queryDocuments, formatDocumentsForContext, getRelevantContext } from './rag/queryPinecone';

// Caché simple para evitar llamadas repetidas a la API para mensajes idénticos
const intentClassificationCache: Map<string, any> = new Map();

// Función para extraer el tema principal de una consulta usando IA
async function extractMainTopic(message: string): Promise<string | null> {
  console.log('[Luna] Extrayendo tema principal usando IA para:', message);
  
  try {
    // Verificar si hay una entrada en caché para este mensaje
    const cacheKey = `topic_${message.toLowerCase().trim()}`;
    if (intentClassificationCache.has(cacheKey)) {
      console.log('[Luna] Usando resultado en caché para extracción de tema');
      const cachedResult = intentClassificationCache.get(cacheKey);
      return cachedResult as string | null;
    }
    
    // Usar la API de OpenAI para clasificar el tema principal
    const prompt = `
Analiza el siguiente mensaje y determina a qué tema municipal se refiere.
Los temas posibles son:
- habilitaciones_comerciales (relacionado con habilitaciones de negocios, locales comerciales)
- impuestos_municipales (relacionado con tasas, tributos, pagos municipales, ABL)
- obras_particulares (relacionado con construcciones, edificaciones, permisos de obra)
- tramites_municipales (relacionado con trámites, gestiones, documentos municipales)
- servicios_municipales (relacionado con servicios públicos municipales)
- reclamos (relacionado con quejas, denuncias, reclamos)

Mensaje: "${message}"

Responde con un JSON en el siguiente formato:
{
  "topic": "nombre_del_tema" (o null si no corresponde a ninguno de los temas listados),
  "confidence": 0.0-1.0
}
`;

    // Llamar a la API
    const apiMessages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: prompt
      }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: apiMessages,
      response_format: { type: 'json_object' },
      max_tokens: 150,
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    
    // Solo considerar el tema si la confianza es suficiente
    const topic = (result.confidence >= 0.6) ? result.topic : null;
    
    // Guardar en caché para futuras consultas
    intentClassificationCache.set(cacheKey, topic);
    
    console.log(`[Luna] Tema principal detectado: ${topic || 'ninguno'} (confianza: ${result.confidence || 'N/A'})`);
    return topic;
  } catch (error) {
    console.error('[Luna] Error al extraer tema principal:', error);
    return null;
  }
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
    const queryResult = await queryDocuments(queryToUse, 5);
    const relevantDocs = queryResult.results;
    const confidenceInfo = queryResult.confidence;
    
    // 2. Si no hay resultados relevantes, usar el flujo normal
    if (relevantDocs.length === 0) {
      console.log('[RAG] No se encontraron documentos relevantes, usando flujo normal');
      return generateStandardResponse(message, conversationState, messageHistory);
    }
    
    // 3. Verificar si la información es confiable
    if (!confidenceInfo.isReliable) {
      console.log(`[RAG] Información no confiable (${confidenceInfo.confidence.toFixed(2)}): ${confidenceInfo.reason}`);
      
      // Generar una respuesta indicando que no tenemos información precisa
      return {
        isComplaint: false,
        message: `Lo siento, no tengo información precisa sobre tu consulta.`,
        // Añadir flag para indicar que no se debe completar esta respuesta
        skipCompletion: true
      };
    }
    
    // 4. Preparar el contexto con la información recuperada
    console.log(`[RAG] Preparando contexto con ${relevantDocs.length} documentos relevantes (confianza: ${confidenceInfo.confidence.toFixed(2)})`);
    const context = formatDocumentsForContext(relevantDocs);
    
    // 5. Generar la respuesta incluyendo el contexto
    console.log('[RAG] Generando respuesta con contexto enriquecido');
    const systemPrompt = getSystemPrompt(conversationState);
    
    // 6. Construir el prompt completo con el contexto de los documentos y recordatorios adicionales
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
    
    // 7. Llamar a la API de OpenAI con el contexto enriquecido
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

// Función para generar recomendaciones cuando no hay información precisa
async function getNoInfoRecommendation(message: string): Promise<string> {
  console.log('[Luna] Generando recomendación para consulta sin información precisa usando IA');
  
  try {
    // Verificar si hay una entrada en caché para este mensaje
    const cacheKey = `rec_${message.toLowerCase().trim()}`;
    if (intentClassificationCache.has(cacheKey)) {
      console.log('[Luna] Usando resultado en caché para recomendación');
      const cachedResult = intentClassificationCache.get(cacheKey);
      return cachedResult as string;
    }
    
    // Usar la API de OpenAI para clasificar el tipo de consulta
    const prompt = `
Analiza el siguiente mensaje y determina a qué categoría de consulta municipal pertenece.
Las categorías posibles son:
- tramites (relacionado con trámites, gestiones, solicitudes, formularios)
- horarios (relacionado con horarios de atención, apertura, cierre)
- ubicacion (relacionado con ubicaciones, direcciones, lugares)
- contacto (relacionado con teléfonos, emails, formas de contacto)
- requisitos (relacionado con requisitos, documentos necesarios)
- general (si no encaja en ninguna de las anteriores)

Mensaje: "${message}"

Responde con un JSON en el siguiente formato:
{
  "category": "nombre_de_la_categoria",
  "confidence": 0.0-1.0
}
`;

    // Llamar a la API
    const apiMessages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: prompt
      }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: apiMessages,
      response_format: { type: 'json_object' },
      max_tokens: 150,
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    
    // Determinar la categoría de la consulta
    const queryType = result.category || 'general';
    console.log(`[Luna] Categoría de consulta detectada: ${queryType} (confianza: ${result.confidence || 'N/A'})`);
    
    // Generar recomendación según el tipo de consulta
    let recommendation: string;
    
    switch (queryType) {
      case 'tramites':
        recommendation = "[INFO] Para obtener información precisa sobre este trámite, te recomiendo contactar directamente a la Municipalidad de Tafí Viejo. También puedes visitar el sitio web oficial: www.tafiviejo.gob.ar";
        break;
      
      case 'horarios':
        recommendation = "[INFO] Para confirmar los horarios actualizados, te recomiendo contactar a la Municipalidad de Tafí Viejo o acercarte personalmente a Av. Sáenz Peña 234, Tafí Viejo.";
        break;
      
      case 'ubicacion':
        recommendation = "[INFO] Para obtener la ubicación exacta, puedes contactar a la Municipalidad de Tafí Viejo o acercarte personalmente a Av. Sáenz Peña 234, Tafí Viejo.";
        break;
      
      case 'contacto':
        recommendation = "[INFO] Para obtener los datos de contacto actualizados, te recomiendo contactar a la Municipalidad de Tafí Viejo o visitar el sitio web oficial: www.tafiviejo.gob.ar";
        break;
      
      case 'requisitos':
        recommendation = "[INFO] Para conocer los requisitos exactos y actualizados, te recomiendo contactar directamente a la Municipalidad de Tafí Viejo o acercarte personalmente a Av. Sáenz Peña 234, Tafí Viejo.";
        break;
      
      default:
        recommendation = "[INFO] Te recomiendo contactar directamente a la Municipalidad de Tafí Viejo, acercarte personalmente a Av. Sáenz Peña 234, Tafí Viejo, o visitar el sitio web oficial: www.tafiviejo.gob.ar para obtener información precisa sobre tu consulta.";
    }
    
    // Guardar en caché para futuras consultas
    intentClassificationCache.set(cacheKey, recommendation);
    
    return recommendation;
  } catch (error) {
    console.error('[Luna] Error al generar recomendación:', error);
    // En caso de error, devolver una recomendación genérica
    return "[INFO] Te recomiendo contactar directamente a la Municipalidad de Tafí Viejo, acercarte personalmente a Av. Sáenz Peña 234, Tafí Viejo, o visitar el sitio web oficial: www.tafiviejo.gob.ar para obtener información precisa sobre tu consulta.";
  }
}

// Función para verificar si todos los datos del reclamo están completos
function isComplaintDataComplete(state: ConversationState): boolean {
  if (!state.isComplaintInProgress || !state.complaintData) {
    return false;
  }
  
  const data = state.complaintData;
  
  // Verificar cada campo individualmente para facilitar la depuración
  const hasType = !!data.type;
  const hasDescription = !!data.description;
  const hasLocation = !!data.location;
  const hasName = !!data.citizenData?.name;
  const hasDocumentId = !!data.citizenData?.documentId;
  const hasAddress = !!data.citizenData?.address;
  
  // Registrar el estado de cada campo para depuración
  console.log('[Luna] Verificando completitud de datos del reclamo:');
  console.log(`- Tipo: ${hasType ? 'Completo' : 'Pendiente'} (${data.type || 'undefined'})`);
  console.log(`- Descripción: ${hasDescription ? 'Completo' : 'Pendiente'} (${data.description || 'undefined'})`);
  console.log(`- Ubicación: ${hasLocation ? 'Completo' : 'Pendiente'} (${data.location || 'undefined'})`);
  console.log(`- Nombre: ${hasName ? 'Completo' : 'Pendiente'} (${data.citizenData?.name || 'undefined'})`);
  console.log(`- DNI: ${hasDocumentId ? 'Completo' : 'Pendiente'} (${data.citizenData?.documentId || 'undefined'})`);
  console.log(`- Dirección: ${hasAddress ? 'Completo' : 'Pendiente'} (${data.citizenData?.address || 'undefined'})`);
  
  // Verificar si todos los campos están completos
  const isComplete = hasType && hasDescription && hasLocation && hasName && hasDocumentId && hasAddress;
  console.log(`[Luna] Reclamo ${isComplete ? 'COMPLETO' : 'INCOMPLETO'}`);
  
  return isComplete;
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
      message: `He recopilado todos los datos necesarios para tu reclamo. Aquí está el resumen:\n${complaintSummary.trim()}\n\nPor favor, responde únicamente CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo. Al confirmar, aceptas que tus datos personales sean compartidos con la municipalidad y almacenados en nuestra base de datos para la gestión de tu reclamo.`,
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

// Procesador para el modo de reclamos
async function processComplaintMode(message: string, state: ConversationState, history: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Procesando mensaje en modo COMPLAINT');
  
  // Detectar si el mensaje parece una consulta informativa
  const isInfoQuery = await isLikelyInformationQuery(message);
  if (isInfoQuery && !state.awaitingConfirmation && !state.confirmationRequested) {
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
  
  console.log(`[Luna] Estado de confirmación: completo=${complaintComplete}, confirmationRequested=${confirmationRequested}, awaitingConfirmation=${state.awaitingConfirmation}`);
  
  // Si el mensaje parece ser una dirección y no tenemos la dirección guardada aún
  if (!state.complaintData?.citizenData?.address && message.length > 5 && !message.toLowerCase().includes('confirmar') && !message.toLowerCase().includes('cancelar')) {
    console.log('[Luna] Posible dirección detectada, actualizando datos del ciudadano');
    
    // Actualizar la dirección en los datos del ciudadano
    if (!state.complaintData.citizenData) {
      state.complaintData.citizenData = {
        name: undefined,
        documentId: undefined,
        address: message.trim()
      };
    } else {
      state.complaintData.citizenData.address = message.trim();
    }
    
    console.log(`[Luna] Dirección actualizada: ${state.complaintData.citizenData.address}`);
    
    // Verificar nuevamente si el reclamo está completo después de actualizar la dirección
    const updatedComplaintComplete = isComplaintDataComplete(state);
    
    if (updatedComplaintComplete) {
      console.log('[Luna] Reclamo completo después de actualizar la dirección, solicitando confirmación');
      
      // Crear un resumen de los datos del reclamo
      const complaintSummary = `
• Tipo: ${state.complaintData.type}
• Descripción: ${state.complaintData.description}
• Ubicación del problema: ${state.complaintData.location}
• Nombre: ${state.complaintData.citizenData.name}
• DNI: ${state.complaintData.citizenData.documentId}
• Dirección de residencia: ${state.complaintData.citizenData.address}
      `;
      
      // Actualizar el estado para indicar que se ha solicitado confirmación
      state.confirmationRequested = true;
      state.awaitingConfirmation = true;
      
      // Devolver una respuesta que solicite confirmación explícita
      return {
        isComplaint: true,
        message: `Gracias por proporcionar tu dirección de residencia, ${state.complaintData.citizenData.name}. He registrado que vives en ${state.complaintData.citizenData.address}. Ahora tengo todos los datos necesarios para tu reclamo sobre ${state.complaintData.description} en ${state.complaintData.location}:\n\n${complaintSummary.trim()}\n\nPor favor, responde CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo. Al confirmar, aceptas que tus datos personales sean compartidos con la municipalidad y almacenados en nuestra base de datos para la gestión de tu reclamo.`,
        data: state.complaintData
      };
    }
  }
  
  // Si el reclamo está completo y no se ha solicitado confirmación, forzar la solicitud
  if (complaintComplete && !confirmationRequested && !message.toLowerCase().includes('confirmar') && !message.toLowerCase().includes('cancelar')) {
    console.log('[Luna] Reclamo completo detectado, solicitando confirmación explícita');
    
    // Crear un resumen de los datos del reclamo
    const complaintData = state.complaintData!;
    const complaintSummary = `
• Tipo: ${complaintData.type}
• Descripción: ${complaintData.description}
• Ubicación: ${complaintData.location}
• Nombre: ${complaintData.citizenData?.name}
• DNI: ${complaintData.citizenData?.documentId}
• Dirección: ${complaintData.citizenData?.address}
    `;
    
    // Actualizar el estado para indicar que se ha solicitado confirmación
    state.confirmationRequested = true;
    state.awaitingConfirmation = true; // Sincronizar ambos flags
    
    // Devolver una respuesta que solicite confirmación explícita
    return {
      isComplaint: true,
      message: `He recopilado todos los datos necesarios para tu reclamo. Aquí está el resumen:\n${complaintSummary.trim()}\n\nPor favor, responde únicamente CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo. Al confirmar, aceptas que tus datos personales sean compartidos con la municipalidad y almacenados en nuestra base de datos para la gestión de tu reclamo.`,
      data: state.complaintData
    };
  }
  
  // Para otros casos, usar el flujo normal
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
    }
    
    return response;
  }
}

// Procesador para el modo por defecto
async function processDefaultMode(message: string, state: ConversationState, history: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Procesando mensaje en modo DEFAULT');
  
  // Usar IA para clasificar la intención del mensaje
  console.log('[Luna] Mensaje ambiguo, utilizando IA para clasificar intención');
  const classification = await classifyMessageIntent(message);
  
  // Si es un reclamo con confianza suficiente
  if (classification.isComplaint && classification.confidence >= 0.6) {
    console.log('[Luna] IA clasificó el mensaje como reclamo (confianza: ' + classification.confidence + ')');
    
    // Cambiar al modo COMPLAINT
    state.mode = ConversationMode.COMPLAINT;
    state.isComplaintInProgress = true;
    
    // Inicializar datos del reclamo
    state.complaintData = {
      type: undefined,
      description: message,
      location: undefined,
      citizenData: {
        name: undefined,
        documentId: undefined,
        address: undefined
      }
    };
    
    return await processComplaintMode(message, state, history);
  } 
  // Si es una consulta informativa
  else if (classification.isInformationQuery && classification.confidence >= 0.6) {
    console.log('[Luna] IA clasificó el mensaje como consulta informativa (confianza: ' + classification.confidence + ')');
    
    // Si hay un reclamo en progreso, guardamos el modo anterior
    if (state.isComplaintInProgress) {
      state.previousMode = state.mode;
      console.log('[Luna] Guardando modo anterior:', state.previousMode);
    }
    
    state.mode = ConversationMode.INFO;
    return await processInfoMode(message, state, history);
  }
  
  // Para mensajes generales, usar RAG solo si es necesario según la clasificación
  const useRAG = classification.isInformationQuery;
  
  if (useRAG) {
    console.log('[Luna] Usando RAG para posible consulta informativa');
    return await generateResponseWithRAG(message, state, history);
  } else {
    console.log('[Luna] No usando RAG para mensaje general');
    console.log('[Luna] Generando respuesta estándar');
    
    // Generar respuesta usando el modelo de lenguaje
    return await generateStandardResponse(message, state, history);
  }
}

// Función para clasificar la intención del mensaje usando IA
async function classifyMessageIntent(message: string): Promise<{isComplaint: boolean, confidence: number, isInformationQuery: boolean}> {
  try {
    console.log('[Luna] Clasificando intención del mensaje usando IA');
    
    // Verificar si el mensaje ya está en caché
    const normalizedMessage = message.toLowerCase().trim();
    if (intentClassificationCache.has(normalizedMessage)) {
      const cachedResult = intentClassificationCache.get(normalizedMessage);
      console.log('[Luna] Usando resultado en caché para mensaje similar');
      // Asegurarse de que el resultado no sea undefined
      if (cachedResult) {
        return cachedResult as {isComplaint: boolean, confidence: number, isInformationQuery: boolean};
      }
    }
    
    // Para todos los mensajes, usar la API de OpenAI
    const prompt = `
Eres un asistente especializado en clasificar mensajes para un chatbot municipal. Tu tarea es determinar si el siguiente mensaje del usuario tiene la intención de hacer un reclamo, una consulta informativa, o es un saludo/mensaje general.

### Ejemplos de mensajes que SÍ son reclamos:
- "La calle de mi barrio está llena de baches"
- "Hace una semana que no pasa el camión de la basura por mi casa"
- "Hay un árbol a punto de caerse frente a mi casa en Av. Belgrano 123"
- "Los vecinos tiran basura en el terreno baldío de la esquina"
- "El semáforo de la esquina de San Martín y Belgrano no funciona"
- "Afuera de mi casa se está formando un basurero, vivo en Sargento Cabral altura 400"
- "Me robaron la moto frente a mi casa"
- "Hay un perro abandonado en la plaza"
- "No hay luz en toda la cuadra desde ayer"

### Ejemplos de mensajes que son CONSULTAS INFORMATIVAS:
- "¿Dónde puedo pagar mis impuestos municipales?"
- "¿Cuál es el horario de atención de la municipalidad?"
- "¿Qué documentos necesito para renovar mi licencia de conducir?"
- "¿Cuándo es el próximo evento cultural en la plaza?"
- "¿Cómo separo correctamente los residuos?"
- "¿Cuánto cuesta la licencia de conducir?"
- "¿Qué trámites puedo hacer online?"

### Ejemplos de mensajes GENERALES (ni reclamos ni consultas específicas):
- "Hola"
- "Buenos días"
- "¿Cómo estás?"
- "Gracias por la información"
- "Adiós"
- "Hasta luego"

### Mensaje del usuario:
"${message}"

Clasifica este mensaje y responde en formato JSON con la siguiente estructura:
{
  "isComplaint": true/false,
  "isInformationQuery": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "Breve explicación de tu clasificación"
}

Nota: Un mensaje puede ser clasificado como reclamo o como consulta informativa, pero no ambos a la vez.
`;

    console.log('[Luna] Enviando solicitud a OpenAI...');
    
    // Llamar a la API
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: "system", content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0.1
    });

    console.log('[Luna] Respuesta recibida de OpenAI');
    
    // Parsear la respuesta
    const content = response.choices[0]?.message?.content;
    console.log('[Luna] Contenido de la respuesta:', content);
    
    if (!content) {
      console.error('[Luna] Respuesta vacía de OpenAI');
      return {
        isComplaint: false,
        confidence: 0,
        isInformationQuery: false
      };
    }
    
    try {
      const result = JSON.parse(content);
      console.log(`[Luna] Clasificación IA: ${result.isComplaint ? 'RECLAMO' : result.isInformationQuery ? 'CONSULTA' : 'GENERAL'} (Confianza: ${result.confidence})`);
      
      // Guardar el resultado en caché
      intentClassificationCache.set(normalizedMessage, {
        isComplaint: result.isComplaint,
        confidence: result.confidence,
        isInformationQuery: result.isInformationQuery
      });
      
      return {
        isComplaint: result.isComplaint,
        confidence: result.confidence,
        isInformationQuery: result.isInformationQuery
      };
    } catch (parseError) {
      console.error('[Luna] Error al parsear la respuesta JSON:', parseError);
      console.error('[Luna] Contenido que causó el error:', content);
      return {
        isComplaint: false,
        confidence: 0,
        isInformationQuery: false
      };
    }
  } catch (error) {
    console.error('[Luna] Error al clasificar intención con IA:', error);
    // En caso de error, asumir valores por defecto
    return {
      isComplaint: false,
      confidence: 0,
      isInformationQuery: false
    };
  }
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
- SIEMPRE termina tus mensajes con una pregunta clara o instrucción sobre qué debe responder el usuario.
- Incluye TODA la información relevante en el campo "message", incluyendo la pregunta final.
- NO uses el campo "nextQuestion" (está obsoleto).
- Si estás recolectando datos para un reclamo, asegúrate de que el usuario sepa exactamente qué información necesitas a continuación.

# SALUDOS INICIALES
- Cuando saludes por primera vez o respondas a un saludo del usuario, SIEMPRE menciona que puedes ayudar con dos tipos de flujos:
  1. Flujo de INFORMACIÓN: para responder consultas sobre trámites, servicios y temas municipales.
  2. Flujo de RECLAMOS: para registrar y dar seguimiento a reclamos municipales.
- Explica brevemente que el usuario puede usar /info para consultas informativas o iniciar directamente un reclamo describiendo su problema.
- Siempre informa que estás en continuo aprendizaje y si en algún momento la conversación no es clara, comunica al usuario que puede utilizar el comando /reiniciar para comenzar de nuevo.
- Mantén este mensaje inicial breve pero informativo. 

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
- La "dirección" (address) se refiere a DÓNDE VIVE EL CIUDADANO que hace el reclamo
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
- SIEMPRE utiliza toda la información relevante de los documentos para dar una respuesta completa
- Cuando respondas sobre trámites o procedimientos, incluye TODOS los pasos necesarios
- Si hay requisitos específicos, enuméralos TODOS
- NUNCA respondas con "¿Te gustaría que te dé más detalles?" o frases similares - SE PROACTIVO, MENCIONA LOS DETALLES SIN ESPERAR A QUE EL USUARIO LOS PREGUNTE.
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
- La "dirección" (address) se refiere a DÓNDE VIVE EL CIUDADANO que hace el reclamo

# INSTRUCCIONES PARA RESPONDER CONSULTAS INFORMATIVAS
- Proporciona respuestas DETALLADAS y COMPLETAS basadas en la información de los documentos
- SIEMPRE INCLUYE TODOS LOS DATOS RELEVANTES en el campo "message", nunca los omitas.
- Incluye TODOS los datos relevantes como requisitos, procedimientos, horarios, ubicaciones, etc.
- SIEMPRE utiliza toda la información relevante de los documentos para dar una respuesta completa
- Cuando respondas sobre trámites o procedimientos, incluye TODOS los pasos necesarios
- Si hay requisitos específicos, enuméralos TODOS
- NUNCA respondas con "¿Te gustaría que te dé más detalles?" o frases similares - SE PROACTIVO, MENCIONA LOS DETALLES SIN ESPERAR A QUE EL USUARIO LOS PREGUNTE.
`;
  }

  // Ejemplos de respuestas correctas
  const examplesPrompt = `
# EJEMPLOS DE RESPUESTAS CORRECTAS

## Ejemplo 1: Inicio de conversación
Usuario: "Hola"
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

Por favor, responde CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo. Al confirmar, aceptas que tus datos personales sean compartidos con la municipalidad y almacenados en nuestra base de datos para la gestión de tu reclamo."

## Ejemplo 8: Interrupción durante reclamo
Usuario: "¿Cuánto tarda en resolverse?"
Asistente:
message: "Los reclamos de alumbrado público suelen resolverse en un plazo de 3 a 5 días hábiles, dependiendo de la complejidad del problema y la disponibilidad de materiales.

Volvamos a tu reclamo anterior. Estábamos registrando un problema de poste de luz caído en la esquina de Avenida Aconquija y Bascary. ¿Deseas continuar con el registro del reclamo?"

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

// Función para determinar el modo de conversación
async function determineConversationMode(message: string, state: ConversationState, history: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Determinando modo de conversación para:', message);
  
  // Si hay un reclamo en progreso y el usuario quiere explícitamente cambiar de tema, reseteamos
  const isExplicitModeChange = message.toLowerCase().includes('cancelar') || 
                              message.toLowerCase().includes('olvidar') || 
                              message.toLowerCase().includes('cambiar de tema');
  
  if (state.isComplaintInProgress && isExplicitModeChange) {
    console.log('[Luna] Usuario solicitó cambio explícito de modo, reseteando estado de reclamo');
    state.isComplaintInProgress = false;
    state.complaintData = {
      type: undefined,
      description: "",
      location: undefined,
      citizenData: {
        name: undefined,
        documentId: undefined,
        address: undefined
      }
    };
    state.mode = ConversationMode.DEFAULT;
    
    return {
      isComplaint: false,
      message: "He cancelado el reclamo en progreso. ¿En qué más puedo ayudarte?"
    };
  }
  
  // Optimización: Si ya estamos en un modo específico y hay un reclamo en progreso, 
  // continuar en ese modo sin reclasificar
  if (state.isComplaintInProgress && state.mode === ConversationMode.COMPLAINT) {
    console.log('[Luna] Continuando con el reclamo en progreso sin reclasificar');
    return await processComplaintMode(message, state, history);
  }
  
  // Verificar si es un comando específico
  if (await isSpecificCommand(message)) {
    console.log('[Luna] Procesando comando específico:', message);
    return await processDefaultMode(message, state, history);
  }
  
  // Usar IA para clasificar la intención del mensaje
  const classification = await classifyMessageIntent(message);
  
  // Si es un reclamo con confianza suficiente
  if (classification.isComplaint && classification.confidence >= 0.6) {
    console.log('[Luna] IA clasificó el mensaje como reclamo (confianza: ' + classification.confidence + ')');
    
    // Cambiar al modo COMPLAINT
    state.mode = ConversationMode.COMPLAINT;
    state.isComplaintInProgress = true;
    
    // Inicializar datos del reclamo
    state.complaintData = {
      type: undefined,
      description: message,
      location: undefined,
      citizenData: {
        name: undefined,
        documentId: undefined,
        address: undefined
      }
    };
    
    return await processComplaintMode(message, state, history);
  } 
  // Si es una consulta informativa
  else if (classification.isInformationQuery && classification.confidence >= 0.6) {
    console.log('[Luna] IA clasificó el mensaje como consulta informativa (confianza: ' + classification.confidence + ')');
    
    // Si hay un reclamo en progreso, guardamos el modo anterior
    if (state.isComplaintInProgress) {
      state.previousMode = state.mode;
      console.log('[Luna] Guardando modo anterior:', state.previousMode);
    }
    
    state.mode = ConversationMode.INFO;
    return await processInfoMode(message, state, history);
  }
  
  // Si es un mensaje general o la confianza es baja
  else {
    // Si hay un reclamo en progreso, continuamos con ese flujo
    if (state.isComplaintInProgress) {
      console.log('[Luna] Continuando con el reclamo en progreso');
      return await processComplaintMode(message, state, history);
    }
    
    // De lo contrario, procesamos en modo default
    console.log('[Luna] Procesando mensaje en modo DEFAULT');
    state.mode = ConversationMode.DEFAULT;
    
    // Para mensajes generales, usar RAG solo si es necesario según la clasificación
    if (classification.isInformationQuery) {
      console.log('[Luna] Usando RAG para posible consulta informativa');
      return await generateResponseWithRAG(message, state, history);
    } else {
      console.log('[Luna] No usando RAG para mensaje general');
      console.log('[Luna] Generando respuesta estándar');
      
      // Generar respuesta usando el modelo de lenguaje
      return await generateStandardResponse(message, state, history);
    }
  }
}

// Función para determinar si es un comando específico
async function isSpecificCommand(message: string): Promise<boolean> {
  console.log('[Luna] Verificando si el mensaje es un comando específico');
  
  try {
    // Verificar si hay una entrada en caché para este mensaje
    const cacheKey = `cmd_${message.toLowerCase().trim()}`;
    if (intentClassificationCache.has(cacheKey)) {
      console.log('[Luna] Usando resultado en caché para clasificación de comando');
      const cachedResult = intentClassificationCache.get(cacheKey);
      return cachedResult && typeof cachedResult === 'object' && cachedResult.isCommand === true;
    }
    
    // Usar la API de OpenAI para clasificar si el mensaje es un comando específico
    const prompt = `
Analiza el siguiente mensaje y determina si es un comando específico para un chatbot municipal.
Los comandos específicos incluyen: cancelar, ayuda, estado, reiniciar, confirmar, misreclamos, o reclamo.

Mensaje: "${message}"

Responde con un JSON en el siguiente formato:
{
  "isCommand": true/false,
  "commandType": "nombre_del_comando" (o null si no es un comando),
  "confidence": 0.0-1.0
}
`;

    // Llamar a la API
    const apiMessages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: prompt
      }
    ];

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: apiMessages,
        response_format: { type: 'json_object' },
        max_tokens: 150,
        temperature: 0.1
      });

      const result = JSON.parse(response.choices[0]?.message?.content || '{}');
      
      // Guardar en caché para futuras consultas
      intentClassificationCache.set(cacheKey, result);
      
      if (result.isCommand) {
        console.log(`[Luna] Detectado comando específico: ${result.commandType} (confianza: ${result.confidence})`);
      }
      
      return result.isCommand === true;
    } catch (error) {
      console.error('[Luna] Error al clasificar comando:', error);
      // En caso de error, devolver false para evitar clasificaciones incorrectas
      return false;
    }
  } catch (error) {
    console.error('[Luna] Error general en isSpecificCommand:', error);
    return false;
  }
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
  
  // 3. Para todos los demás casos, usar clasificación por IA para determinar si es una consulta informativa
  console.log('[Luna] Permitiendo que el modelo determine si necesita información adicional');
  return true;
}

// Función para determinar si un mensaje es probablemente un reclamo
// Esta función ahora es un wrapper que llama a la clasificación por IA
async function isLikelyComplaintByAI(message: string): Promise<{isComplaint: boolean, confidence: number, isInformationQuery: boolean}> {
  // Clasificar el mensaje con IA
  return await classifyMessageIntent(message);
}

// Función para determinar si un mensaje es una consulta informativa
// Esta función ahora utiliza la clasificación por IA en lugar de patrones
async function isLikelyInformationQuery(message: string): Promise<boolean> {
  console.log('[Luna] Verificando si el mensaje es una consulta informativa usando IA');
  
  try {
    // Usar la clasificación por IA para determinar si es una consulta informativa
    const classification = await classifyMessageIntent(message);
    return classification.isInformationQuery;
  } catch (error) {
    console.error('[Luna] Error al clasificar mensaje como consulta informativa:', error);
    // En caso de error, devolver false para evitar cambiar el flujo incorrectamente
    return false;
  }
}

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
  
  const isReady = hasType && hasDescription && hasLocation && hasName && hasDocumentId && hasAddress;
  console.log(`Reclamo ${isReady ? 'LISTO' : 'NO LISTO'} para guardar`);
  
  return isReady;
}

// Función para generar texto
export async function generateText(message: string, conversationState?: ConversationState, messageHistory?: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Generando respuesta para:', message);
  
  // Inicializar estado si no existe
  const state = conversationState || {
    isComplaintInProgress: false,
    complaintData: {
      type: undefined,
      description: "",
      location: undefined,
      citizenData: {
        name: undefined,
        documentId: undefined,
        address: undefined
      }
    },
    currentStep: 'INIT',
    mode: ConversationMode.DEFAULT
  };
  
  // Inicializar historial si no existe
  const history = messageHistory || [];
  
  try {
    // Si es un comando específico, procesarlo directamente
    if (await isSpecificCommand(message)) {
      console.log('[Luna] Procesando comando específico:', message);
      return await processDefaultMode(message, state, history);
    }
    
    // Si es un mensaje vacío o muy corto, responder genéricamente
    if (!message || message.trim().length < 2) {
      return {
        isComplaint: false,
        message: "Por favor, escribe un mensaje más detallado para que pueda ayudarte mejor."
      };
    }
    
    // Determinar el modo de conversación usando IA
    return await determineConversationMode(message, state, history);
    
  } catch (error) {
    console.error('[Luna] Error general en generateText:', error);
    return {
      isComplaint: false,
      message: "Lo siento, tuve un problema al procesar tu mensaje. ¿Podrías intentarlo de nuevo o expresarlo de otra manera?"
    };
  }
}
