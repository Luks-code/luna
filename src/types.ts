// Interfaz para la respuesta estructurada de GPT
export interface GPTResponse {
  isComplaint: boolean;
  data?: ComplaintData;
  /**
   * @deprecated Este campo será eliminado en futuras versiones. 
   * Incluir la pregunta directamente al final del campo message.
   */
  nextQuestion?: string;
  message: string;
  /**
   * Si es true, indica que la respuesta no debe pasar por el proceso de completado
   * Útil para respuestas donde no queremos que el modelo alucine información
   */
  skipCompletion?: boolean;
}

// Datos del reclamo
export interface ComplaintData {
  type?: string;
  description?: string;
  location?: string;
  citizenData?: CitizenData;
}

// Datos del ciudadano
export interface CitizenData {
  name?: string;
  documentId?: string;
  phone?: string;
  address?: string;
}

// Mensaje en la conversación
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// Estructura completa de datos de conversación
export interface ConversationData {
  state: ConversationState;
  messageHistory: ConversationMessage[];
}

// Estado de la conversación
export interface ConversationState {
  pseudoComplaintHandling: boolean;
  spamMetrics: any;
  isComplaintInProgress: boolean;
  complaintData: ComplaintData;
  currentStep: 'INIT' | 'COLLECTING_TYPE' | 'COLLECTING_DESCRIPTION' | 'COLLECTING_CITIZEN_DATA' | 'AWAITING_CONFIRMATION' | 'COMPLETE';
  awaitingConfirmation?: boolean;
  confirmedData?: ComplaintData;
  
  // Campos para manejo de contexto
  currentIntent?: IntentType;
  pendingFields?: string[]; // Campos que faltan por completar
  conversationTopics?: string[]; // Temas discutidos en la conversación
  lastInteractionTimestamp?: number; // Para manejar tiempos de inactividad
  confirmationRequested?: boolean; // Campo para rastrear si se ha solicitado confirmación
}

// Tipos de intención
export enum IntentType {
  COMPLAINT = 'COMPLAINT'
}

// Comandos disponibles
export const COMMANDS = {
  CANCELAR: 'CANCELAR',
  AYUDA: 'AYUDA',
  ESTADO: 'ESTADO',
  REINICIAR: 'REINICIAR',
  CONFIRMAR: 'CONFIRMAR',
  MISRECLAMOS: 'MISRECLAMOS',
  RECLAMO: 'RECLAMO'
} as const;

export type Command = typeof COMMANDS[keyof typeof COMMANDS];

// Estados de reclamos
export enum ComplaintStatus {
  PENDIENTE = 'PENDIENTE',
  EN_PROCESO = 'EN_PROCESO',
  RESUELTO = 'RESUELTO',
  CANCELADO = 'CANCELADO'
}
