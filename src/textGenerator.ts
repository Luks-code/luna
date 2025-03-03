// textGenerator.ts
import openai from './openai';
import { GPTResponse, ConversationState, ComplaintData } from './types';
import { ComplaintTypes } from './prisma';

// Mapa para almacenar el estado de las conversaciones por número de teléfono
const conversationStates = new Map<string, ConversationState>();

const generateText = async (userMessage: string, phone: string): Promise<GPTResponse> => {
  try {
    // Obtener o inicializar el estado de la conversación
    const state = getOrCreateConversationState(phone);

    // Llamada al modelo GPT-4
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `
Eres un asistente virtual oficial de la Municipalidad de Tafí Viejo.
Tu función principal es recibir reclamos de los ciudadanos de manera clara, amable y formal.

IMPORTANTE: Debes responder SIEMPRE en formato JSON con la siguiente estructura:
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
  "nextQuestion": string (siguiente pregunta para completar información),
  "message": string (mensaje para el usuario)
}

Cuando detectes un reclamo:
1. Marca isComplaint como true
2. Extrae toda la información proporcionada en el mensaje
3. Indica qué información falta por recolectar
4. Sé amable y formal

Tipos de reclamos disponibles:
${Object.entries(ComplaintTypes).map(([key, value]) => `${key}: ${value}`).join('\n')}

Estado actual de la conversación:
${JSON.stringify(state, null, 2)}
`,
        },
        {
          role: 'user',
          content: userMessage,
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 500,
      temperature: 0.7,
    });

    const gptResponse = JSON.parse(response.choices[0]?.message?.content || '{}') as GPTResponse;
    
    // Actualizar el estado de la conversación con la nueva información
    updateConversationState(phone, gptResponse);

    return gptResponse;
  } catch (error: any) {
    console.error('Error generating text:', error.message);
    return {
      isComplaint: false,
      message: 'Lo siento, ocurrió un inconveniente. Por favor, intenta más tarde.'
    };
  }
};

function getOrCreateConversationState(phone: string): ConversationState {
  if (!conversationStates.has(phone)) {
    conversationStates.set(phone, {
      isComplaintInProgress: false,
      complaintData: {},
      currentStep: 'INIT'
    });
  }
  return conversationStates.get(phone)!;
}

function updateConversationState(phone: string, response: GPTResponse) {
  const state = getOrCreateConversationState(phone);
  
  if (response.isComplaint) {
    state.isComplaintInProgress = true;
    
    // Actualizar datos del reclamo
    if (response.data) {
      state.complaintData = {
        ...state.complaintData,
        ...response.data
      };
    }

    // Actualizar el paso actual basado en qué información falta
    if (!state.complaintData.type) {
      state.currentStep = 'COLLECTING_TYPE';
    } else if (!state.complaintData.description || !state.complaintData.location) {
      state.currentStep = 'COLLECTING_DESCRIPTION';
    } else if (!state.complaintData.citizenData || 
               !state.complaintData.citizenData.name || 
               !state.complaintData.citizenData.documentId || 
               !state.complaintData.citizenData.address) {
      state.currentStep = 'COLLECTING_CITIZEN_DATA';
    } else {
      state.currentStep = 'COMPLETE';
    }
  }

  conversationStates.set(phone, state);
}

export default generateText;
