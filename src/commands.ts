import { Command, COMMANDS, ComplaintStatus, ConversationState, ConversationMode } from './types';
import { setConversationState, initialConversationState, addMessageToHistory, redis, deleteConversation } from './redis';
import { sendWhatsAppMessage } from './whatsapp';
import { prisma } from './prisma';

export async function handleCommand(from: string, command: string, state: ConversationState): Promise<void> {
  const parts = command.toUpperCase().split(' ');
  const cmd = parts[0] as Command;
  const args = parts.slice(1);

  switch (cmd) {
    case COMMANDS.CANCELAR:
      await handleCancel(from, state);
      break;
    case COMMANDS.AYUDA:
      await handleHelp(from);
      break;
    case COMMANDS.ESTADO:
      await handleStatus(from, state);
      break;
    case COMMANDS.REINICIAR:
      await handleReset(from);
      break;
    case COMMANDS.CONFIRMAR:
      await handleConfirm(from, state);
      break;
    case COMMANDS.MISRECLAMOS:
      await handleMyComplaints(from);
      break;
    case COMMANDS.RECLAMO:
      if (args.length === 0) {
        // Si no hay argumentos, cambiar al modo de reclamos
        await handleModeChange(from, state, ConversationMode.COMPLAINT);
      } else {
        // Si hay argumentos, buscar detalles del reclamo específico
        await handleComplaintDetails(from, parseInt(args[0]));
      }
      break;
    case COMMANDS.INFO:
    case COMMANDS.CONSULTA:
      await handleModeChange(from, state, ConversationMode.INFO);
      break;
    case COMMANDS.NORMAL:
    case COMMANDS.DEFAULT:
      await handleModeChange(from, state, ConversationMode.DEFAULT);
      break;
    default:
      const message = 'Comando no reconocido. Usa /ayuda para ver los comandos disponibles.';
      await sendWhatsAppMessage(from, message);
      await addMessageToHistory(from, 'assistant', message);
  }
}

async function handleCancel(from: string, state: ConversationState): Promise<void> {
  let message = '';
  
  if (!state.isComplaintInProgress) {
    message = 'No hay ninguna operación en curso para cancelar.';
    await sendWhatsAppMessage(from, message);
    await addMessageToHistory(from, 'assistant', message);
  } else {
    // Mensaje de cancelación
    message = 'Se ha cancelado el reclamo en curso.';
    await sendWhatsAppMessage(from, message);
    await addMessageToHistory(from, 'assistant', message);
    
    // Mensaje de reinicio
    const resetMessage = 'La conversación ha sido reiniciada completamente.';
    await sendWhatsAppMessage(from, resetMessage);
    
    // Eliminar completamente la conversación usando la nueva función
    const deleted = await deleteConversation(from);
    console.log(`[Comando /cancelar] Conversación eliminada: ${deleted ? 'Sí' : 'No'}`);
  }
}

async function handleHelp(from: string): Promise<void> {
  const helpMessage = `Comandos disponibles:
/ayuda - Muestra este mensaje
/estado - Muestra el estado actual del reclamo en curso
/cancelar - Cancela el reclamo en curso
/reiniciar - Reinicia la conversación
/confirmar - Confirma el reclamo cuando se solicite
/misreclamos - Muestra todos tus reclamos
/reclamo - Cambia al modo de reclamos para iniciar un nuevo reclamo
/reclamo <número> - Muestra los detalles de un reclamo específico
/info o /consulta - Cambia al modo de información para hacer consultas
/normal o /default - Vuelve al modo normal de conversación

Para iniciar un reclamo, puedes usar el comando /reclamo o simplemente describir tu problema y te guiaré en el proceso.`;

  await sendWhatsAppMessage(from, helpMessage);
  await addMessageToHistory(from, 'assistant', helpMessage);
}

async function handleStatus(from: string, state: ConversationState): Promise<void> {
  let message = '';
  
  if (!state.isComplaintInProgress) {
    message = 'No hay ningún reclamo en curso.';
  } else {
    const { complaintData } = state;
    message = `Estado actual del reclamo:
${complaintData.type ? `✅ Tipo: ${complaintData.type}` : '❌ Tipo: Pendiente'}
${complaintData.description ? `✅ Descripción: ${complaintData.description}` : '❌ Descripción: Pendiente'}
${complaintData.location ? `✅ Ubicación: ${complaintData.location}` : '❌ Ubicación: Pendiente'}
${complaintData.citizenData?.name ? `✅ Nombre: ${complaintData.citizenData.name}` : '❌ Nombre: Pendiente'}
${complaintData.citizenData?.documentId ? `✅ DNI: ${complaintData.citizenData.documentId}` : '❌ DNI: Pendiente'}
${complaintData.citizenData?.address ? `✅ Dirección: ${complaintData.citizenData.address}` : '❌ Dirección: Pendiente'}`;
  }

  await sendWhatsAppMessage(from, message);
  await addMessageToHistory(from, 'assistant', message);
}

async function handleReset(from: string): Promise<void> {
  const message = 'La conversación ha sido reiniciada completamente. ¿En qué puedo ayudarte?';
  
  // Eliminar completamente la conversación de Redis usando la nueva función
  const deleted = await deleteConversation(from);
  console.log(`[Comando /reiniciar] Conversación eliminada: ${deleted ? 'Sí' : 'No'}`);
  
  // Enviar mensaje de confirmación
  await sendWhatsAppMessage(from, message);
}

async function handleConfirm(from: string, state: ConversationState): Promise<void> {
  let message = '';
  
  if (!state.awaitingConfirmation) {
    message = 'No hay ningún reclamo pendiente de confirmación.';
  } else {
    // La confirmación real se maneja en whatsapp.ts
    state.confirmedData = state.complaintData;
    await setConversationState(from, state);
    message = 'Procesando confirmación...';
  }
  
  await sendWhatsAppMessage(from, message);
  await addMessageToHistory(from, 'assistant', message);
}

function getStatusEmoji(status: ComplaintStatus): string {
  switch (status) {
    case ComplaintStatus.PENDIENTE:
      return '⏳';
    case ComplaintStatus.EN_PROCESO:
      return '🔄';
    case ComplaintStatus.RESUELTO:
      return '✅';
    case ComplaintStatus.CANCELADO:
      return '❌';
    default:
      return '❓';
  }
}

async function handleMyComplaints(from: string): Promise<void> {
  try {
    // Buscar el ciudadano por número de teléfono
    const citizen = await prisma.citizen.findFirst({
      where: { phone: from },
      include: {
        complaints: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    let message = '';
    
    if (!citizen || citizen.complaints.length === 0) {
      message = 'No tienes reclamos registrados.';
    } else {
      const complaintsList = citizen.complaints.map(complaint => {
        const statusEmoji = getStatusEmoji(complaint.status as ComplaintStatus);
        return `🔸 #${complaint.id} - ${complaint.type} ${statusEmoji}
      📍 ${complaint.location}
      📅 ${complaint.createdAt.toLocaleDateString()}`;
      }).join('\n\n');

      message = `Tus reclamos:\n\n${complaintsList}\n\nPara ver más detalles de un reclamo específico, usa /reclamo <número>`;
    }

    await sendWhatsAppMessage(from, message);
    await addMessageToHistory(from, 'assistant', message);

  } catch (error) {
    console.error('Error al obtener reclamos:', error);
    const errorMessage = 'Lo siento, hubo un problema al obtener tus reclamos. Por favor, intenta más tarde.';
    await sendWhatsAppMessage(from, errorMessage);
    await addMessageToHistory(from, 'assistant', errorMessage);
  }
}

async function handleComplaintDetails(from: string, complaintId: number): Promise<void> {
  try {
    const complaint = await prisma.complaint.findFirst({
      where: {
        id: complaintId,
        citizen: {
          phone: from
        }
      },
      include: {
        citizen: true
      }
    });

    let message = '';
    
    if (!complaint) {
      message = 'No se encontró el reclamo especificado o no tienes permiso para verlo.';
    } else {
      const statusEmoji = getStatusEmoji(complaint.status as ComplaintStatus);
      message = `📋 Detalles del Reclamo #${complaint.id}:
🔹 Tipo: ${complaint.type}
📝 Descripción: ${complaint.description}
📍 Ubicación: ${complaint.location}
📅 Fecha: ${complaint.createdAt.toLocaleDateString()}
${statusEmoji} Estado: ${complaint.status}${complaint.status === ComplaintStatus.CANCELADO && complaint.rejectReason ? `
❌ Motivo de rechazo: ${complaint.rejectReason}` : ''}

👤 Datos del Ciudadano:
- Nombre: ${complaint.citizen.name}
- DNI: ${complaint.citizen.documentId}
- Dirección: ${complaint.citizen.address}`;
    }

    await sendWhatsAppMessage(from, message);
    await addMessageToHistory(from, 'assistant', message);

  } catch (error) {
    console.error('Error al obtener detalles del reclamo:', error);
    const errorMessage = 'Lo siento, hubo un problema al obtener los detalles del reclamo. Por favor, intenta más tarde.';
    await sendWhatsAppMessage(from, errorMessage);
    await addMessageToHistory(from, 'assistant', errorMessage);
  }
}

// Función para cambiar el modo de conversación
async function handleModeChange(from: string, state: ConversationState, newMode: ConversationMode): Promise<void> {
  // Guardar el modo anterior
  state.previousMode = state.mode;
  
  // Establecer el nuevo modo
  state.mode = newMode;
  
  // Reiniciar la bandera de mensaje de cambio de modo
  state.modeChangeMessageSent = false;
  
  // Mensaje según el modo
  let message = '';
  
  switch (newMode) {
    case ConversationMode.INFO:
      message = 'He cambiado al modo de información. Ahora puedes hacerme cualquier consulta sobre servicios, trámites o información municipal y utilizaré nuestra base de conocimiento para responderte de la manera más completa posible.';
      break;
    case ConversationMode.COMPLAINT:
      message = 'He cambiado al modo de reclamos. Ahora puedes describir tu problema y te guiaré para registrar un reclamo formal.';
      break;
    case ConversationMode.DEFAULT:
      message = 'He vuelto al modo normal. Puedo ayudarte tanto con consultas de información como con reclamos según lo que necesites.';
      break;
  }
  
  // Guardar el estado actualizado
  await setConversationState(from, state);
  
  // Enviar mensaje de confirmación
  await sendWhatsAppMessage(from, message);
  await addMessageToHistory(from, 'assistant', message);
}
