// textGenerator.ts
import openai from './openai';
import { GPTResponse, ConversationState, ConversationMessage, IntentType } from './types';
import { ComplaintTypes } from './prisma';
import { ChatCompletionMessageParam } from 'openai/resources/chat';

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
Analiza el siguiente mensaje y determina a qué tema se refiere.
Los temas posibles son:
- reclamos (relacionado con quejas, denuncias, reclamos municipales)

Mensaje: "${message}"

Responde con un JSON en el siguiente formato:
{
  "topic": "reclamos" (o null si no es un reclamo),
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

// Función para llamar a la API de OpenAI con un prompt
async function callOpenAI(systemPrompt: string, messageHistory: ConversationMessage[] = [], userMessage?: string): Promise<GPTResponse> {
  try {
    // Construir los mensajes para la API
    const apiMessages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: systemPrompt
      }
    ];

    // Añadir el historial de mensajes si existe
    if (messageHistory && messageHistory.length > 0) {
      apiMessages.push(
        ...messageHistory.map(msg => ({
          role: msg.role as "user" | "assistant",
          content: msg.content
        }))
      );
    }

    // Añadir el mensaje actual del usuario si se proporciona
    if (userMessage) {
      apiMessages.push({
        role: "user",
        content: userMessage
      });
    }

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
  const systemPrompt = getSystemPrompt(state);
  
  // Llamar a OpenAI con el prompt del sistema, historial y mensaje actual
  return await callOpenAI(systemPrompt, history, message);
}

// Procesador para el modo de reclamos
async function processComplaintMode(message: string, state: ConversationState, history: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Procesando mensaje en modo COMPLAINT');
  
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

// Función para obtener el prompt del sistema según el estado
function getSystemPrompt(conversationState: ConversationState): string {
  // Prompt base con instrucciones generales
  const basePrompt = `
# INSTRUCCIONES PARA ASISTENTE MUNICIPAL NINA

Eres Nina, un asistente virtual de la Municipalidad de Tafí Viejo, Tucumán, Argentina.

# FORMATO DE RESPUESTA
- Tus respuestas deben ser concisas, claras y amigables.
- SIEMPRE termina tus mensajes con una pregunta clara o instrucción sobre qué debe responder el usuario.
- Incluye TODA la información relevante en el campo "message", incluyendo la pregunta final.
- NO uses el campo "nextQuestion" (está obsoleto).
- Si estás recolectando datos para un reclamo, asegúrate de que el usuario sepa exactamente qué información necesitas a continuación.

# SALUDOS INICIALES
- Cuando saludes por primera vez o respondas a un saludo del usuario, SIEMPRE menciona que puedes ayudar con la gestión de reclamos municipales.
- Explica brevemente que el usuario puede iniciar directamente un reclamo describiendo su problema.
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
`;
  
  // Instrucciones específicas según el estado
  let stateSpecificPrompt = `
# ESTADO ACTUAL
- Estado del reclamo: ${conversationState.isComplaintInProgress ? 'En progreso' : 'No iniciado'}
- Datos del reclamo:
${Object.entries(conversationState.complaintData || {})
  .filter(([key, value]) => value !== undefined && key !== 'citizenData')
  .map(([key, value]) => `   - ${key}: ${value}`)
  .join('\n')}

${conversationState.complaintData?.citizenData ? 
`- Datos del ciudadano:
${Object.entries(conversationState.complaintData.citizenData)
  .filter(([key, value]) => value !== undefined)
  .map(([key, value]) => `   - ${key}: ${value}`)
  .join('\n')}
` : ''}
`;
  
  // Ejemplos de respuestas correctas
  const examplesPrompt = `
# EJEMPLOS DE RESPUESTAS CORRECTAS

## Ejemplo 1: Inicio de conversación
Usuario: "Hola"
Asistente: 
message: "¡Hola! 👋 Soy Nina, la asistente virtual de la Municipalidad de Tafí Viejo. Estoy aquí para ayudarte a registrar reclamos municipales. ¿En qué puedo ayudarte hoy? Puedes describirme directamente el problema que deseas reportar."

## Ejemplo 2: Consulta informativa (redirigir a reclamos)
Usuario: "¿Qué necesito para sacar la licencia de conducir?"
Asistente:
message: "Actualmente solo puedo ayudarte con la gestión de reclamos municipales. Si tienes algún problema con servicios municipales que deseas reportar, puedes describirlo y te ayudaré a registrarlo. ¿Hay algún reclamo que quieras realizar?"

## Ejemplo 3: Inicio de reclamo
Usuario: "Hay un poste de luz caído en mi calle"
Asistente:
message: "Entiendo que quieres reportar un problema con el alumbrado público. He registrado que hay un poste de luz caído. Para continuar con tu reclamo, ¿podrías proporcionarme más detalles sobre la ubicación exacta donde se encuentra el poste caído?"

## Ejemplo 4: Recolección de datos - Ubicación
Usuario: "Está en la esquina de Avenida Aconquija y Bascary"
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
message: "Estamos enfocados en registrar tu reclamo en este momento. Para poder ayudarte mejor, necesito que completemos el proceso de registro primero. Una vez registrado, podrás hacer seguimiento de su estado. ¿Deseas continuar con el registro del reclamo?"

## Ejemplo 9: Comandos
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
  return `${basePrompt}${stateSpecificPrompt}${examplesPrompt}`;
}

// Exportar la función por defecto para compatibilidad con código existente
export default generateText;

// Función para generar texto
export async function generateText(message: string, conversationState?: ConversationState, messageHistory?: ConversationMessage[]): Promise<GPTResponse> {
  console.log('[Luna] Generando respuesta para:', message);
  
  // Inicializar estado si no existe
  const state = conversationState || {
    isComplaintInProgress: true, // Siempre en modo reclamo
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
    currentStep: 'INIT'
  };
  
  // Inicializar historial si no existe
  const history = messageHistory || [];
  
  try {
    // Si es un comando específico, procesarlo directamente
    if (await isSpecificCommand(message)) {
      console.log('[Luna] Procesando comando específico:', message);
      return await processComplaintMode(message, state, history);
    }
    
    // Si es un mensaje vacío o muy corto, responder genéricamente
    if (!message || message.trim().length < 2) {
      return {
        isComplaint: true,
        message: "Por favor, escribe un mensaje más detallado para que pueda ayudarte con tu reclamo."
      };
    }
    
    // Procesar directamente como un reclamo
    return await processComplaintMode(message, state, history);
    
  } catch (error) {
    console.error('[Luna] Error general en generateText:', error);
    return {
      isComplaint: true,
      message: "Lo siento, tuve un problema al procesar tu reclamo. ¿Podrías intentarlo de nuevo o expresarlo de otra manera?"
    };
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
Analiza el siguiente mensaje y determina si es un comando específico para un chatbot municipal de reclamos.
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
