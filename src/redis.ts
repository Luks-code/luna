import { Redis } from '@upstash/redis';
import { ConversationState } from './types';

// Inicializar cliente de Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

// Tiempo de expiración en segundos (10 minutos)
const TTL_SECONDS = 600;

// Prefijo para las claves de conversación
const CONVERSATION_PREFIX = 'conversation:';

export async function getConversationState(phoneNumber: string): Promise<ConversationState | null> {
  try {
    console.log(`Intentando obtener estado para ${phoneNumber}...`);
    const state = await redis.get<ConversationState>(CONVERSATION_PREFIX + phoneNumber);
    console.log('Estado obtenido:', state);
    return state;
  } catch (error) {
    console.error('Error al obtener estado de Redis:', error);
    return null;
  }
}

export async function setConversationState(phoneNumber: string, state: ConversationState): Promise<void> {
  try {
    console.log(`Guardando estado para ${phoneNumber}:`, state);
    // Usar setex para establecer el valor con un TTL
    await redis.setex(CONVERSATION_PREFIX + phoneNumber, TTL_SECONDS, state);
    console.log('Estado guardado exitosamente');
  } catch (error) {
    console.error('Error al guardar estado en Redis:', error);
  }
}

export async function deleteConversationState(phoneNumber: string): Promise<void> {
  try {
    console.log(`Eliminando estado para ${phoneNumber}...`);
    await redis.del(CONVERSATION_PREFIX + phoneNumber);
    console.log('Estado eliminado exitosamente');
  } catch (error) {
    console.error('Error al eliminar estado de Redis:', error);
  }
}

// Estado inicial de una conversación
export const initialConversationState: ConversationState = {
  isComplaintInProgress: false,
  complaintData: {},
  currentStep: 'INIT'
};
