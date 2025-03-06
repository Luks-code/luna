import { Redis } from '@upstash/redis';
import { ConversationState, ConversationData, ConversationMessage, IntentType } from './types';

// Inicializar cliente de Redis
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

// Tiempo de expiración en segundos (10 minutos)
const TTL_SECONDS = 600;

// Prefijo para las claves de conversación
const CONVERSATION_PREFIX = 'conversation:';

// Máximo número de mensajes a mantener en el historial
const MAX_MESSAGE_HISTORY = 15;

export async function getConversationState(phoneNumber: string): Promise<ConversationState | null> {
  try {
    console.log(`Intentando obtener estado para ${phoneNumber}...`);
    const conversationData = await redis.get<ConversationData>(CONVERSATION_PREFIX + phoneNumber);
    
    // Si no hay datos o es el formato antiguo (solo estado)
    if (!conversationData || !('state' in conversationData)) {
      // Si es el formato antiguo (solo el estado), convertirlo al nuevo formato
      if (conversationData) {
        console.log('Formato antiguo detectado, convirtiendo...');
        return conversationData as unknown as ConversationState;
      }
      return null;
    }
    
    console.log('Estado obtenido:', conversationData.state);
    return conversationData.state;
  } catch (error) {
    console.error('Error al obtener estado de Redis:', error);
    return null;
  }
}

export async function getMessageHistory(phoneNumber: string): Promise<ConversationMessage[]> {
  try {
    console.log(`Intentando obtener historial de mensajes para ${phoneNumber}...`);
    const conversationData = await redis.get<ConversationData>(CONVERSATION_PREFIX + phoneNumber);
    
    // Si no hay datos o es el formato antiguo (solo estado)
    if (!conversationData || !('messageHistory' in conversationData)) {
      return [];
    }
    
    console.log(`Historial obtenido: ${conversationData.messageHistory.length} mensajes`);
    return conversationData.messageHistory;
  } catch (error) {
    console.error('Error al obtener historial de Redis:', error);
    return [];
  }
}

export async function setConversationState(phoneNumber: string, state: ConversationState): Promise<void> {
  try {
    console.log(`Guardando estado para ${phoneNumber}:`, state);
    
    // Obtener los datos actuales (si existen)
    const currentData = await redis.get<ConversationData>(CONVERSATION_PREFIX + phoneNumber);
    
    // Crear nueva estructura de datos
    const conversationData: ConversationData = {
      state: state,
      messageHistory: (currentData && 'messageHistory' in currentData) 
        ? currentData.messageHistory 
        : []
    };
    
    // Guardar con TTL
    await redis.setex(CONVERSATION_PREFIX + phoneNumber, TTL_SECONDS, conversationData);
    console.log('Estado guardado exitosamente');
  } catch (error) {
    console.error('Error al guardar estado en Redis:', error);
  }
}

export async function addMessageToHistory(
  phoneNumber: string, 
  role: 'user' | 'assistant', 
  content: string
): Promise<void> {
  try {
    console.log(`Añadiendo mensaje de ${role} al historial para ${phoneNumber}`);
    
    // Obtener los datos actuales
    const currentData = await redis.get<ConversationData>(CONVERSATION_PREFIX + phoneNumber);
    
    // Preparar el nuevo mensaje
    const newMessage: ConversationMessage = {
      role,
      content,
      timestamp: Date.now()
    };
    
    // Crear o actualizar la estructura de datos
    let conversationData: ConversationData;
    
    if (!currentData || !('state' in currentData)) {
      // Si no hay datos o es formato antiguo
      const state = (currentData as unknown as ConversationState) || initialConversationState;
      conversationData = {
        state,
        messageHistory: [newMessage]
      };
    } else {
      // Añadir el nuevo mensaje al historial
      const updatedHistory = [...currentData.messageHistory, newMessage]
        // Mantener solo los últimos MAX_MESSAGE_HISTORY mensajes
        .slice(-MAX_MESSAGE_HISTORY);
      
      conversationData = {
        state: currentData.state,
        messageHistory: updatedHistory
      };
    }
    
    // Guardar con TTL
    await redis.setex(CONVERSATION_PREFIX + phoneNumber, TTL_SECONDS, conversationData);
    console.log('Mensaje añadido al historial exitosamente');
  } catch (error) {
    console.error('Error al añadir mensaje al historial:', error);
  }
}

export async function deleteConversationState(phoneNumber: string): Promise<void> {
  try {
    console.log(`Eliminando conversación para ${phoneNumber}...`);
    await redis.del(CONVERSATION_PREFIX + phoneNumber);
    console.log('Conversación eliminada exitosamente');
  } catch (error) {
    console.error('Error al eliminar conversación de Redis:', error);
  }
}

// Estado inicial de una conversación
export const initialConversationState: ConversationState = {
  isComplaintInProgress: false,
  complaintData: {},
  currentStep: 'INIT',
  awaitingConfirmation: false,
  
  // Nuevos campos de contexto
  currentIntent: IntentType.GREETING,
  previousIntent: undefined,
  pendingFields: [],
  conversationTopics: [],
  lastInteractionTimestamp: Date.now(),
  interruptedFlow: false,
  interruptionContext: {
    originalIntent: undefined,
    pendingQuestion: undefined,
    resumePoint: undefined
  }
};
