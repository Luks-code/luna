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

// Estado de la conversación
export interface ConversationState {
  isComplaintInProgress: boolean;
  complaintData: ComplaintData;
  currentStep: 'INIT' | 'COLLECTING_TYPE' | 'COLLECTING_DESCRIPTION' | 'COLLECTING_CITIZEN_DATA' | 'COMPLETE';
}
