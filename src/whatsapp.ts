import { Express, Request, Response } from 'express';
import axios from 'axios';
import { generateText } from './textGenerator';
import { findOrCreateCitizen, createComplaint } from './prisma';
import { 
  getConversationState, 
  setConversationState, 
  initialConversationState,
  getMessageHistory,
  addMessageToHistory,
  redis
} from './redis';
import { handleCommand } from './commands';

export async function sendWhatsAppMessage(to: string, message: string) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to,
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error al enviar mensaje de WhatsApp:', error);
  }
}

// Función para verificar si tenemos todos los datos necesarios para guardar el reclamo
function isReadyToSave(complaintData: any): boolean {
  console.log('Verificando si el reclamo está listo para guardar:', JSON.stringify(complaintData, null, 2));
  
  return (
    complaintData.type &&
    complaintData.description &&
    complaintData.location &&
    complaintData.citizenData?.name &&
    complaintData.citizenData?.documentId &&
    complaintData.citizenData?.address
  );
}

export function setupWhatsAppWebhook(app: Express) {
  app.get('/webhook', (req: Request, res: Response) => {
    const verifyToken = process.env.VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token && mode === 'subscribe' && token === verifyToken) {
      console.log('Webhook verificado correctamente!');
      return res.status(200).send(challenge);
    } else {
      console.log('Fallo en la verificación del Webhook.');
      return res.sendStatus(403);
    }
  });

  app.post('/webhook', async (req: Request, res: Response) => {
    res.sendStatus(200);

    const body = req.body;
    if (!body.object || !body.entry?.[0]?.changes?.[0]) return;

    const changes = body.entry[0].changes[0];
    const messages = changes.value?.messages;

    if (!messages?.[0]) return;

    const msg = messages[0];
    const from = msg.from;
    const textType = msg.type;

    if (textType !== 'text') {
      await sendWhatsAppMessage(
        from,
        'Lo siento, en este momento solo puedo procesar mensajes de texto. ¿Podrías escribir tu mensaje, por favor?'
      );
      return;
    }

    const userText = msg.text.body.trim();

    try {
      // Obtener el estado actual
      let conversationState = await getConversationState(from);
      if (!conversationState) {
        conversationState = initialConversationState;
      }

      // Obtener el historial de mensajes
      const messageHistory = await getMessageHistory(from);

      // Añadir el mensaje del usuario al historial
      await addMessageToHistory(from, 'user', userText);

      // Manejar comandos especiales
      if (userText.startsWith('/')) {
        const commandText = userText.substring(1);
        // Añadir el comando al historial
        await addMessageToHistory(from, 'user', userText);
        await handleCommand(commandText, from, conversationState);
        return;
      }

      // Manejar confirmación si está pendiente
      if (conversationState.awaitingConfirmation) {
        const upperText = userText.toUpperCase();
        if (upperText === 'CONFIRMAR') {
          // Guardar el reclamo y reiniciar el estado
          await saveComplaint(from, conversationState.complaintData);
          
          // Asegurarse de que el estado se ha reiniciado completamente
          await setConversationState(from, {
            ...initialConversationState,
            isComplaintInProgress: false,
            awaitingConfirmation: false,
            complaintData: {}
          });
          
          return;
        } else if (upperText === 'CANCELAR') {
          // Reiniciar el estado
          await setConversationState(from, {
            ...initialConversationState,
            isComplaintInProgress: false,
            awaitingConfirmation: false,
            complaintData: {}
          });
          
          const cancelMessage = 'Reclamo cancelado. ¿Puedo ayudarte en algo más?';
          await sendWhatsAppMessage(from, cancelMessage);
          await addMessageToHistory(from, 'assistant', cancelMessage);
          return;
        } else {
          const promptMessage = 'Por favor, responde "CONFIRMAR" para guardar el reclamo o "CANCELAR" para descartarlo.';
          await sendWhatsAppMessage(from, promptMessage);
          await addMessageToHistory(from, 'assistant', promptMessage);
          return;
        }
      }

      // Generar respuesta con OpenAI incluyendo el historial de mensajes
      const response = await generateText(userText, conversationState, messageHistory);
      
      // Construir el mensaje completo incluyendo la pregunta siguiente si existe
      let fullMessage = response.message;
      if (response.nextQuestion && response.isComplaint) {
        fullMessage = `${response.message}\n\n${response.nextQuestion}`;
      }
      
      await sendWhatsAppMessage(from, fullMessage);
      
      // Añadir la respuesta del asistente al historial
      await addMessageToHistory(from, 'assistant', fullMessage);

      // Actualizar estado de la conversación
      if (response.isComplaint) {
        conversationState.isComplaintInProgress = true;
        conversationState.complaintData = {
          ...conversationState.complaintData,
          ...response.data
        };

        // Si tenemos todos los datos, pedir confirmación
        if (isReadyToSave(conversationState.complaintData)) {
          const confirmationMessage = `Por favor, confirma que los siguientes datos son correctos:
- Tipo: ${conversationState.complaintData.type}
- Descripción: ${conversationState.complaintData.description}
- Ubicación: ${conversationState.complaintData.location}
- Nombre: ${conversationState.complaintData.citizenData?.name}
- DNI: ${conversationState.complaintData.citizenData?.documentId}
- Dirección: ${conversationState.complaintData.citizenData?.address}
`;

          conversationState.awaitingConfirmation = true;
          await setConversationState(from, conversationState);
          await sendWhatsAppMessage(from, confirmationMessage);
          
          // Añadir el mensaje de confirmación al historial
          await addMessageToHistory(from, 'assistant', confirmationMessage);
          return;
        }
      }

      await setConversationState(from, conversationState);
    } catch (error) {
      console.error('Error al procesar mensaje:', error);
      await sendWhatsAppMessage(
        from,
        'Lo siento, ocurrió un error inesperado. Por favor, intenta más tarde.'
      );
    }
  });
}

async function saveComplaint(from: string, complaintData: any) {
  try {
    const citizen = await findOrCreateCitizen({
      name: complaintData.citizenData.name,
      documentId: complaintData.citizenData.documentId,
      phone: from,
      address: complaintData.citizenData.address
    });

    const complaint = await createComplaint({
      type: complaintData.type,
      description: complaintData.description,
      location: complaintData.location,
      citizenId: citizen.id
    });

    // Crear el mensaje de confirmación
    const confirmationMessage = `✅ Reclamo registrado exitosamente!\nNúmero de reclamo: #${complaint.id}\nTipo: ${complaint.type}\nEstado: Pendiente de revisión`;
    
    await sendWhatsAppMessage(from, confirmationMessage);

    await sendWhatsAppMessage(from, "La conversación será reiniciada.");

    await redis.del(`conversation:${from}`);

  } catch (error) {
    console.error('Error al guardar reclamo:', error);
    const errorMessage = 'Lo siento, ocurrió un error al guardar tu reclamo. Por favor, intenta nuevamente.';
    await sendWhatsAppMessage(from, errorMessage);
    await addMessageToHistory(from, 'assistant', errorMessage);
  }
}
