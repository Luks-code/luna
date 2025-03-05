import { ConversationState, Command, COMMANDS, ComplaintStatus } from './types';
import { setConversationState, initialConversationState } from './redis';
import { sendWhatsAppMessage } from './whatsapp';
import { prisma } from './prisma';

export async function handleCommand(command: string, from: string, state: ConversationState): Promise<void> {
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
        await sendWhatsAppMessage(from, 'Por favor, especifica el número de reclamo. Ejemplo: /reclamo 123');
      } else {
        await handleComplaintDetails(from, parseInt(args[0]));
      }
      break;
    default:
      await sendWhatsAppMessage(from, 
        'Comando no reconocido. Usa /ayuda para ver los comandos disponibles.');
  }
}

async function handleCancel(from: string, state: ConversationState): Promise<void> {
  if (!state.isComplaintInProgress) {
    await sendWhatsAppMessage(from, 'No hay ninguna operación en curso para cancelar.');
    return;
  }

  await setConversationState(from, initialConversationState);
  await sendWhatsAppMessage(from, 
    'Se ha cancelado el reclamo en curso. Puedes iniciar uno nuevo cuando quieras.');
}

async function handleHelp(from: string): Promise<void> {
  const helpMessage = `Comandos disponibles:
/ayuda - Muestra este mensaje
/estado - Muestra el estado actual del reclamo en curso
/cancelar - Cancela el reclamo en curso
/reiniciar - Reinicia la conversación
/confirmar - Confirma el reclamo cuando se solicite
/misreclamos - Muestra todos tus reclamos
/reclamo <número> - Muestra los detalles de un reclamo específico

Para iniciar un reclamo, simplemente describe tu problema y te guiaré en el proceso.`;

  await sendWhatsAppMessage(from, helpMessage);
}

async function handleStatus(from: string, state: ConversationState): Promise<void> {
  if (!state.isComplaintInProgress) {
    await sendWhatsAppMessage(from, 'No hay ningún reclamo en curso.');
    return;
  }

  const { complaintData } = state;
  const status = `Estado actual del reclamo:
${complaintData.type ? `✅ Tipo: ${complaintData.type}` : '❌ Tipo: Pendiente'}
${complaintData.description ? `✅ Descripción: ${complaintData.description}` : '❌ Descripción: Pendiente'}
${complaintData.location ? `✅ Ubicación: ${complaintData.location}` : '❌ Ubicación: Pendiente'}
${complaintData.citizenData?.name ? `✅ Nombre: ${complaintData.citizenData.name}` : '❌ Nombre: Pendiente'}
${complaintData.citizenData?.documentId ? `✅ DNI: ${complaintData.citizenData.documentId}` : '❌ DNI: Pendiente'}
${complaintData.citizenData?.address ? `✅ Dirección: ${complaintData.citizenData.address}` : '❌ Dirección: Pendiente'}`;

  await sendWhatsAppMessage(from, status);
}

async function handleReset(from: string): Promise<void> {
  await setConversationState(from, initialConversationState);
  await sendWhatsAppMessage(from, 
    'La conversación ha sido reiniciada. ¿En qué puedo ayudarte?');
}

async function handleConfirm(from: string, state: ConversationState): Promise<void> {
  if (!state.awaitingConfirmation) {
    await sendWhatsAppMessage(from, 
      'No hay ningún reclamo pendiente de confirmación.');
    return;
  }

  // La confirmación real se maneja en whatsapp.ts
  state.confirmedData = state.complaintData;
  await setConversationState(from, state);
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

    if (!citizen || citizen.complaints.length === 0) {
      await sendWhatsAppMessage(from, 'No tienes reclamos registrados.');
      return;
    }

    const complaintsList = citizen.complaints.map(complaint => {
      const statusEmoji = getStatusEmoji(complaint.status as ComplaintStatus);
      return `🔸 #${complaint.id} - ${complaint.type} ${statusEmoji}
      📍 ${complaint.location}
      📅 ${complaint.createdAt.toLocaleDateString()}`;
    }).join('\n\n');

    await sendWhatsAppMessage(from, 
      `Tus reclamos:\n\n${complaintsList}\n\nPara ver más detalles de un reclamo específico, usa /reclamo <número>`);

  } catch (error) {
    console.error('Error al obtener reclamos:', error);
    await sendWhatsAppMessage(from, 
      'Lo siento, hubo un problema al obtener tus reclamos. Por favor, intenta más tarde.');
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

    if (!complaint) {
      await sendWhatsAppMessage(from, 
        'No se encontró el reclamo especificado o no tienes permiso para verlo.');
      return;
    }

    const statusEmoji = getStatusEmoji(complaint.status as ComplaintStatus);
    const details = `📋 Detalles del Reclamo #${complaint.id}:
🔹 Tipo: ${complaint.type}
📝 Descripción: ${complaint.description}
📍 Ubicación: ${complaint.location}
📅 Fecha: ${complaint.createdAt.toLocaleDateString()}
${statusEmoji} Estado: ${complaint.status}

👤 Datos del Ciudadano:
- Nombre: ${complaint.citizen.name}
- DNI: ${complaint.citizen.documentId}
- Dirección: ${complaint.citizen.address}`;

    await sendWhatsAppMessage(from, details);

  } catch (error) {
    console.error('Error al obtener detalles del reclamo:', error);
    await sendWhatsAppMessage(from, 
      'Lo siento, hubo un problema al obtener los detalles del reclamo. Por favor, intenta más tarde.');
  }
}
