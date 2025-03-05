// whatsapp.ts
import { Express, Request, Response } from 'express';
import axios from 'axios';
import generateText from './textGenerator';
import { prisma, findOrCreateCitizen, createComplaint } from './prisma';
import { getConversationState, setConversationState, initialConversationState } from './redis';
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

function isReadyToSave(data?: any): boolean {
  return !!(
    data?.type &&
    data?.description &&
    data?.location &&
    data?.citizenData?.name &&
    data?.citizenData?.documentId &&
    data?.citizenData?.address
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

      // Manejar comandos especiales
      if (userText.startsWith('/')) {
        await handleCommand(userText.substring(1), from, conversationState);
        return;
      }

      // Manejar confirmación si está pendiente
      if (conversationState.awaitingConfirmation) {
        const upperText = userText.toUpperCase();
        if (upperText === 'CONFIRMAR') {
          await saveComplaint(from, conversationState.complaintData);
          return;
        } else if (upperText === 'CANCELAR') {
          await setConversationState(from, initialConversationState);
          await sendWhatsAppMessage(from, 'Reclamo cancelado. ¿Puedo ayudarte en algo más?');
          return;
        } else {
          await sendWhatsAppMessage(
            from,
            'Por favor, responde "CONFIRMAR" para guardar el reclamo o "CANCELAR" para descartarlo.'
          );
          return;
        }
      }

      // Generar respuesta con OpenAI
      const response = await generateText(userText, from, conversationState);
      await sendWhatsAppMessage(from, response.message);

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

Responde "CONFIRMAR" para guardar el reclamo o "CANCELAR" para descartar.`;

          conversationState.awaitingConfirmation = true;
          await setConversationState(from, conversationState);
          await sendWhatsAppMessage(from, confirmationMessage);
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

    await setConversationState(from, initialConversationState);
    await sendWhatsAppMessage(
      from,
      `✅ Reclamo registrado exitosamente!\nNúmero de reclamo: #${complaint.id}\nTipo: ${complaint.type}\nEstado: Pendiente de revisión`
    );
  } catch (error) {
    console.error('Error saving complaint:', error);
    await sendWhatsAppMessage(
      from,
      'Lo siento, hubo un problema al guardar tu reclamo. Por favor, intenta nuevamente.'
    );
  }
}
