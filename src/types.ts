// Interfaz para la respuesta estructurada de GPT
export interface GPTResponse {
  isComplaint: boolean;
  data?: ComplaintData;
  nextQuestion?: string;
  message: string;
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
  isComplaintInProgress: boolean;
  complaintData: ComplaintData;
  currentStep: 'INIT' | 'COLLECTING_TYPE' | 'COLLECTING_DESCRIPTION' | 'COLLECTING_CITIZEN_DATA' | 'AWAITING_CONFIRMATION' | 'COMPLETE';
  awaitingConfirmation?: boolean;
  confirmedData?: ComplaintData;
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

// Estado del reclamo
export enum ComplaintStatus {
  PENDIENTE = 'PENDIENTE',
  EN_PROCESO = 'EN_PROCESO',
  RESUELTO = 'RESUELTO',
  CANCELADO = 'CANCELADO'
}
