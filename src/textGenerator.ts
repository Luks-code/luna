// textGenerator.ts
import openai from './openai';
import { GPTResponse, ConversationState, ConversationMessage } from './types';
import { ComplaintTypes } from './prisma';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export async function generateText(
  message: string,
  conversationState: ConversationState,
  messageHistory: ConversationMessage[] = []
): Promise<GPTResponse> {
  try {
    // Construir el contexto basado en el estado actual
    const systemPrompt = `Eres Nina, el asistente virtual del municipio de Tafí Viejo que ayuda a los ciudadanos a registrar reclamos y resolver dudas de manera conversacional y amigable.

# PRIORIDADES (ORDENADAS POR IMPORTANCIA)
1. SIEMPRE HACER UNA PREGUNTA ESPECÍFICA AL FINAL DE CADA RESPUESTA
2. Guiar al usuario paso a paso para completar su reclamo
3. Extraer información relevante de forma progresiva
4. Mantener conversaciones naturales y fluidas

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
Usuario: "Hay un problema con la luz en mi calle"
Asistente: 
message: "Entiendo que tienes un problema con el alumbrado público. Voy a registrar un reclamo de Alumbrado Público (AP)."
nextQuestion: "¿Podrías darme más detalles sobre el problema? Por ejemplo, ¿desde cuándo está sin luz la calle?"

## Ejemplo 2: Recolección progresiva
Usuario: "En la calle San Martín 450 no hay luz desde ayer"
Asistente: 
message: "Gracias por la información. He registrado que el problema de alumbrado público está en la calle San Martín 450 desde ayer."
nextQuestion: "Para continuar con el reclamo, ¿podrías proporcionarme tu nombre completo?"

## Ejemplo 3: Extracción de contexto
Usuario: "Soy Juan Pérez, vivo en Belgrano 120 pero el problema es en San Martín"
Asistente: 
message: "Gracias Juan Pérez. He registrado tu nombre y que vives en Belgrano 120."
nextQuestion: "Para continuar con tu reclamo de alumbrado público en la calle San Martín, ¿podrías proporcionarme tu número de DNI?"

# ESTRUCTURA DE RESPUESTA JSON
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
}

# ESTADO ACTUAL DE LA CONVERSACIÓN
${JSON.stringify(conversationState, null, 2)}`;

    // Preparar mensajes para la API de OpenAI
    const apiMessages: ChatCompletionMessageParam[] = [];
    
    // Añadir el mensaje del sistema
    apiMessages.push({
      role: "system",
      content: systemPrompt
    });

    // Añadir historial de mensajes si existe
    if (messageHistory && messageHistory.length > 0) {
      for (const msg of messageHistory) {
        if (msg.role === 'user') {
          apiMessages.push({
            role: 'user',
            content: msg.content
          });
        } else if (msg.role === 'assistant') {
          apiMessages.push({
            role: 'assistant',
            content: msg.content
          });
        }
      }
    }

    // Si el último mensaje no es el actual, añadirlo
    const lastMessage = messageHistory[messageHistory.length - 1];
    if (!lastMessage || lastMessage.role !== 'user' || lastMessage.content !== message) {
      apiMessages.push({
        role: 'user',
        content: message
      });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: apiMessages,
      response_format: { type: 'json_object' },
      max_tokens: 10000,
      temperature: 0.3,
    });

    const gptResponse = JSON.parse(
      response.choices[0]?.message?.content || '{}'
    ) as GPTResponse;

    // Si estamos esperando confirmación, forzar el mensaje
    if (conversationState.awaitingConfirmation) {
      gptResponse.message = 'Por favor, responde CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo.';
    }

    return gptResponse;
  } catch (error) {
    console.error('Error al generar texto:', error);
    return {
      isComplaint: false,
      message: 'Lo siento, ha ocurrido un error. Por favor, intenta nuevamente.',
    };
  }
}
