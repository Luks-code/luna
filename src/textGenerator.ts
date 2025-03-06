// textGenerator.ts
import openai from './openai';
import { GPTResponse, ConversationState, ConversationMessage } from './types';
import { ComplaintTypes } from './prisma';
import { ChatCompletionMessageParam } from 'openai/resources/chat';
import { IntentType } from "./types";
import { queryDocuments } from "./rag/query";

// Función para determinar si una consulta debería usar RAG
async function shouldUseRAG(message: string, conversationState: ConversationState): Promise<boolean> {
  console.log('[RAG] Evaluando si se debe usar RAG para la consulta...');
  
  // Si hay un reclamo en progreso, no usar RAG a menos que sea una consulta informativa
  if (conversationState?.isComplaintInProgress && 
      conversationState?.currentIntent !== IntentType.INQUIRY) {
    console.log('[RAG] No se usará RAG porque hay un reclamo en progreso');
    return false;
  }
  
  // Palabras clave que indican comandos específicos que no deberían usar RAG
  const commandKeywords = [
    'cancelar', 'ayuda', 'estado', 'reiniciar', 'confirmar', 
    'mis reclamos', 'reclamo', 'quiero hacer un reclamo'
  ];
  
  // Si el mensaje contiene palabras clave de comandos, no usar RAG
  const lowercaseMessage = message.toLowerCase();
  const isCommand = commandKeywords.some(keyword => lowercaseMessage.includes(keyword));
  
  if (isCommand) {
    console.log('[RAG] No se usará RAG porque parece ser un comando específico');
    return false;
  }
  
  // Por defecto, intentar usar RAG para cualquier consulta que no sea un comando específico
  console.log('[RAG] Se intentará usar RAG para esta consulta');
  return true;
}

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
      temperature: 0.3,
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
    const relevantDocs = await queryDocuments(queryToUse, 3);
    
    // 2. Si no hay resultados relevantes, usar el flujo normal
    if (relevantDocs.length === 0) {
      console.log('[RAG] No se encontraron documentos relevantes, usando flujo normal');
      return generateStandardResponse(message, conversationState, messageHistory);
    }
    
    // 3. Preparar el contexto con la información recuperada
    console.log(`[RAG] Preparando contexto con ${relevantDocs.length} documentos relevantes`);
    const context = relevantDocs.map((doc, i) => {
      return `Documento ${i+1} (Fuente: ${doc.metadata?.source || 'Desconocida'}):\n${doc.content}`;
    }).join('\n\n');
    
    // 4. Generar la respuesta incluyendo el contexto
    console.log('[RAG] Generando respuesta con contexto enriquecido');
    const systemPromptWithContext = getSystemPrompt(conversationState);
    
    // Mejorar el prompt para generar respuestas más detalladas
    const enhancedPrompt = `${systemPromptWithContext}

### INSTRUCCIONES ESPECIALES PARA RESPONDER CONSULTAS INFORMATIVAS:
- Proporciona respuestas DETALLADAS y COMPLETAS basadas en la información de los documentos.
- Incluye TODOS los datos relevantes como requisitos, procedimientos, horarios, ubicaciones, etc.
- Estructura tu respuesta de manera clara con secciones si es necesario.
- Si el usuario está preguntando por más detalles sobre un tema previo, asegúrate de proporcionar información adicional.
- No omitas información importante por brevedad.
- Si la información en los documentos es técnica, explícala en términos sencillos.
- SIEMPRE utiliza toda la información relevante de los documentos para dar una respuesta completa.
- Cuando respondas sobre trámites o procedimientos, incluye TODOS los pasos necesarios.
- Si hay requisitos específicos, enuméralos TODOS.

### REGLAS CRÍTICAS PARA EVITAR DUPLICACIÓN EN RESPUESTAS RAG:
- El campo "message" DEBE CONTENER ÚNICAMENTE LA INFORMACIÓN ENCONTRADA en los documentos, NUNCA preguntas
- El campo "nextQuestion" DEBE CONTENER ÚNICAMENTE UNA PREGUNTA CONCISA, sin repetir información
- NUNCA repitas información entre "message" y "nextQuestion"
- Si proporcionas un número, dirección o dato específico en "message", NO lo repitas en "nextQuestion"
- Mantén "nextQuestion" lo más breve posible, idealmente una sola pregunta directa
- EJEMPLOS CORRECTOS:
  * message: "El número de contacto de Desarrollo Social es (0381) 461-7890."
    nextQuestion: "¿Necesitas alguna otra información?"
  * message: "Para obtener una habilitación comercial necesitas: 1) DNI, 2) Título de propiedad, 3) Planos aprobados."
    nextQuestion: "¿Puedo ayudarte con algún otro trámite?"

### INFORMACIÓN RELEVANTE DE LA BASE DE CONOCIMIENTO:
${context}

### Historial de conversación:
${formatMessageHistory(messageHistory)}

### Estado actual:
${JSON.stringify(conversationState, null, 2)}

### Mensaje del usuario:
${message}

### Respuesta:`;
    
    // 5. Llamar a la API de OpenAI con el contexto enriquecido
    const response = await callOpenAI(enhancedPrompt);
    console.log('[RAG] Respuesta generada exitosamente usando RAG');
    
    return response;
  } catch (error) {
    console.error('[RAG] Error al generar respuesta con RAG:', error);
    // En caso de error, usar el flujo estándar como fallback
    console.log('[RAG] Usando flujo estándar como fallback debido al error');
    return generateStandardResponse(message, conversationState, messageHistory);
  }
}

// Función para generar respuesta estándar (sin RAG)
async function generateStandardResponse(message: string, conversationState: ConversationState, messageHistory: ConversationMessage[]): Promise<GPTResponse> {
  const systemPromptStandard = getSystemPrompt(conversationState);
  const prompt = `${systemPromptStandard}\n\n### Historial de conversación:\n${formatMessageHistory(messageHistory)}\n\n### Estado actual:\n${JSON.stringify(conversationState, null, 2)}\n\n### Mensaje del usuario:\n${message}\n\n### Respuesta:`;
  return await callOpenAI(prompt);
}

// Función principal para generar texto
export async function generateText(message: string, conversationState?: ConversationState, messageHistory?: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Generando respuesta para mensaje:', message);
  try {
    // Asegurarse de que los parámetros opcionales tengan valores por defecto
    const state = conversationState || {} as ConversationState;
    const history = messageHistory || [];
    
    // Determinar si debemos usar RAG
    const useRAG = await shouldUseRAG(message, state);
    
    if (useRAG) {
      console.log('[Luna] Se usará RAG para generar la respuesta');
      return await generateResponseWithRAG(message, state, history);
    } else {
      console.log('[Luna] Se usará el flujo estándar para generar la respuesta');
      return await generateStandardResponse(message, state, history);
    }
  } catch (error) {
    console.error('[Luna] Error al generar texto:', error);
    return { 
      isComplaint: false,
      message: "Lo siento, ha ocurrido un error. Por favor, intenta de nuevo más tarde." 
    };
  }
}

// Exportar la función por defecto para compatibilidad con código existente
export default generateText;

// Función para obtener el prompt del sistema basado en el estado actual
function getSystemPrompt(conversationState: ConversationState): string {
  return `Eres Nina, el asistente virtual del municipio de Tafí Viejo que ayuda a los ciudadanos a registrar reclamos y resolver dudas de manera conversacional y amigable.

# PRIORIDADES (ORDENADAS POR IMPORTANCIA)
1. SIEMPRE HACER UNA PREGUNTA ESPECÍFICA EN EL CAMPO "nextQuestion", NUNCA en el campo "message"
2. Guiar al usuario paso a paso para completar su reclamo
3. Extraer información relevante de forma progresiva
4. Mantener conversaciones naturales y fluidas
5. Si el usuario saluda, debes presentarte con tu nombre y comunicar tu funcionalidad.
6. MANTENER EL CONTEXTO incluso si el usuario cambia de tema temporalmente
7. RETOMAR el flujo de recolección de datos si fue interrumpido

# REGLAS CRÍTICAS PARA EVITAR DUPLICACIÓN
- El campo "message" DEBE CONTENER ÚNICAMENTE INFORMACIÓN Y RESPUESTAS, nunca preguntas
- El campo "nextQuestion" DEBE CONTENER ÚNICAMENTE UNA PREGUNTA CONCISA, sin repetir información
- NUNCA repitas la misma información entre "message" y "nextQuestion"
- Mantén "nextQuestion" lo más breve posible, idealmente una sola pregunta directa
- Si proporcionas información en "message" (como un número de teléfono), NO la repitas en "nextQuestion"
- Si "message" contiene "El número de contacto es X", "nextQuestion" NO debe mencionar ese número
- EJEMPLOS INCORRECTOS:
  * message: "El número de contacto de Desarrollo Social es (0381) 461-7890."
    nextQuestion: "El número de Desarrollo Social es (0381) 461-7890. ¿Puedo ayudarte en algo más?"
  * message: "Entiendo que necesitas el número de contacto."
    nextQuestion: "¿Necesitas el número de contacto u otra información?"
- EJEMPLOS CORRECTOS:
  * message: "El número de contacto de Desarrollo Social es (0381) 461-7890."
    nextQuestion: "¿Necesitas alguna otra información?"
  * message: "Entiendo que necesitas el número de contacto de Desarrollo Social."
    nextQuestion: "¿Quieres que te proporcione ese número?"

# MANEJO DE MÚLTIPLES INTENCIONES
- Si el usuario menciona múltiples problemas, PRIORIZA completar UN reclamo a la vez
- Si el usuario hace una pregunta durante el registro de un reclamo, responde brevemente y RETOMA el reclamo
- Si el usuario proporciona información contradictoria, usa la información más reciente
- Si el usuario cambia completamente de tema, confirma si desea abandonar el reclamo actual

# FLUJO OBLIGATORIO DE RECOLECCIÓN DE DATOS
Debes recolectar la siguiente información en este orden:
1. Tipo de reclamo (identificar de la conversación)
2. Descripción detallada del problema
3. Ubicación exacta del problema
4. Nombre completo del ciudadano
5. Número de DNI
6. Dirección del ciudadano

# INSTRUCCIONES CRÍTICAS
- SIEMPRE debes incluir una pregunta específica en el campo "nextQuestion", NUNCA en el campo "message"
- El campo "message" debe contener SOLO información y confirmación de lo que has entendido
- NUNCA des por terminada la conversación hasta que todos los datos estén completos
- Recolecta UN DATO A LA VEZ, no pidas múltiples datos en una misma pregunta
- Si ya tienes el tipo de reclamo, pregunta por la descripción detallada
- Si ya tienes la descripción, pregunta por la ubicación exacta
- Si ya tienes la ubicación, pregunta por el nombre completo
- Si ya tienes el nombre, pregunta por el DNI
- Si ya tienes el DNI, pregunta por la dirección
- Cuando tengas todos los datos, solicita confirmación

# COMANDOS DISPONIBLES
- /ayuda - Muestra todos los comandos disponibles
- /estado - Muestra el estado del reclamo actual
- /cancelar - Cancela el reclamo en curso
- /reiniciar - Comienza una nueva conversación
- /confirmar - Guarda el reclamo cuando se solicite
- /misreclamos - Muestra todos tus reclamos anteriores
- /reclamo <número> - Muestra los detalles de un reclamo específico

# TIPOS DE RECLAMOS DISPONIBLES
${Object.entries(ComplaintTypes)
  .map(([key, value]) => `   - ${key}: ${value}`)
  .join('\n')}

# EJEMPLOS DE CONVERSACIONES EFECTIVAS

## Ejemplo 1: Inicio de conversación
Usuario: "Hola, ¿cómo estás?"
Asistente: 
message: "¡Hola! Soy Nina, la asistente virtual del municipio de Tafí Viejo. Estoy aquí para ayudarte a registrar reclamos o resolver tus dudas sobre servicios municipales."
nextQuestion: "¿En qué puedo ayudarte hoy?"

## Ejemplo 2: Identificación de reclamo
Usuario: "Hay un problema con la luz en mi calle"
Asistente: 
message: "Entiendo que tienes un problema con el alumbrado público. Voy a registrar un reclamo de Alumbrado Público (AP)."
nextQuestion: "¿Podrías darme más detalles sobre el problema? Por ejemplo, ¿desde cuándo está sin luz la calle?"

## Ejemplo 3: Recolección progresiva
Usuario: "En la calle San Martín 450 no hay luz desde ayer"
Asistente: 
message: "Gracias por la información. He registrado que el problema de alumbrado público está en la calle San Martín 450 desde ayer."
nextQuestion: "Para continuar con el reclamo, ¿podrías proporcionarme tu nombre completo?"

## Ejemplo 4: Extracción de contexto
Usuario: "Soy Juan Pérez, vivo en Belgrano 120 pero el problema es en San Martín"
Asistente: 
message: "Gracias Juan Pérez. He registrado tu nombre y que vives en Belgrano 120."
nextQuestion: "Para continuar con tu reclamo de alumbrado público en la calle San Martín, ¿podrías proporcionarme tu número de DNI?"

## Ejemplo 5: Manejo de interrupción
Usuario: "¿Cuándo pasa el camión de basura por mi zona?"
Asistente:
message: "El camión de basura pasa por la zona centro los lunes, miércoles y viernes por la mañana. Para otras zonas, puedes consultar el cronograma en la web municipal."
nextQuestion: "Volviendo a tu reclamo de alumbrado público, necesito tu número de DNI para continuar. ¿Podrías proporcionármelo?"

## Ejemplo 6: Cambio de tema
Usuario: "Mejor quiero hacer un reclamo por un bache enorme"
Asistente:
message: "Entiendo que ahora quieres reportar un problema diferente relacionado con un bache. Voy a registrar un nuevo reclamo de Bacheo y Asfalto (BA)."
nextQuestion: "¿Podrías indicarme la ubicación exacta donde se encuentra este bache?"

## Ejemplo 7: Información incompleta
Usuario: "No tengo agua"
Asistente:
message: "Entiendo que tienes un problema con el servicio de agua. Voy a registrar un reclamo de Servicios de Agua y Cloacas (SAT)."
nextQuestion: "¿Desde cuándo estás experimentando este problema con el agua?"

## Ejemplo 8: Confirmación final
Usuario: "Mi DNI es 28456789"
Asistente:
message: "Gracias por proporcionar tu DNI. He registrado todos los datos necesarios para tu reclamo."
nextQuestion: "Por favor, confirma que deseas registrar un reclamo de Alumbrado Público en la calle San Martín 450. Responde CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo."

Debes responder en formato JSON con la siguiente estructura:
{
  "isComplaint": boolean,
  "data": {
    "type": string (opcional, uno de: ${Object.keys(ComplaintTypes).join(', ')}),
    "description": string (opcional),
    "location": string (opcional),
    "citizenData": {
      "name": string (opcional),
      "documentId": string (opcional),
      "address": string (opcional)
    }
  },
  "nextQuestion": string (siguiente pregunta específica, OBLIGATORIO si isComplaint es true),
  "message": string (mensaje conversacional para el usuario, NO debe incluir la pregunta)
}`;
}
