// utils.ts
import { ConversationState } from './types';

// Función para verificar si todos los datos del reclamo están completos
export function isComplaintDataComplete(state: ConversationState): boolean {
  if (!state.isComplaintInProgress || !state.complaintData) {
    return false;
  }
  
  const { complaintData } = state;
  
  // Verificar que todos los campos requeridos estén presentes y no vacíos
  const hasType = !!complaintData.type && complaintData.type.trim() !== '';
  const hasDescription = !!complaintData.description && complaintData.description.trim() !== '';
  const hasLocation = !!complaintData.location && complaintData.location.trim() !== '';
  
  // Verificar datos del ciudadano
  const hasName = !!complaintData.citizenData?.name && complaintData.citizenData.name.trim() !== '';
  const hasDocumentId = !!complaintData.citizenData?.documentId && complaintData.citizenData.documentId.trim() !== '';
  const hasAddress = !!complaintData.citizenData?.address && complaintData.citizenData.address.trim() !== '';
  
  // Logging para depuración
  console.log('[Luna] Verificando completitud de datos:');
  console.log(`- Tipo: ${hasType ? 'OK' : 'FALTA'}`);
  console.log(`- Descripción: ${hasDescription ? 'OK' : 'FALTA'}`);
  console.log(`- Ubicación: ${hasLocation ? 'OK' : 'FALTA'}`);
  console.log(`- Nombre: ${hasName ? 'OK' : 'FALTA'}`);
  console.log(`- DNI: ${hasDocumentId ? 'OK' : 'FALTA'}`);
  console.log(`- Dirección: ${hasAddress ? 'OK' : 'FALTA'}`);
  
  // Todos los campos deben estar completos
  return hasType && hasDescription && hasLocation && hasName && hasDocumentId && hasAddress;
}

// Función para verificar si ya se ha solicitado confirmación
export function hasRequestedConfirmation(state: ConversationState): boolean {
  return !!state.confirmationRequested;
}

// Función para verificar si un reclamo está listo para ser guardado
export function isReadyToSave(state: ConversationState): boolean {
  return isComplaintDataComplete(state) && hasRequestedConfirmation(state);
}
