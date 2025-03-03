// whatsapp.ts
import { Express, Request, Response } from 'express';
import axios from 'axios';
import generateText from './textGenerator';
import { prisma, findOrCreateCitizen, createComplaint } from './prisma';
import { GPTResponse, ConversationState } from './types';

/**
 * setupWhatsAppWebhook
 *
 * Configura las rutas de webhook para la API de WhatsApp
 */
export function setupWhatsAppWebhook(app: Express) {
  // 1) Verificación del Webhook (GET)
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

  // 2) Recepción de mensajes (POST)
  app.post('/webhook', async (req: Request, res: Response) => {
    res.sendStatus(200);

    const body = req.body;

    if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0]) {
      const changes = body.entry[0].changes[0];
      const value = changes.value;
      const messages = value.messages;

      if (messages && messages.length > 0) {
        const msg = messages[0];
        const from = msg.from;
        const textType = msg.type;

        if (textType === 'text') {
          const userText = msg.text.body;

          try {
            // Generamos la respuesta con OpenAI
            const response = await generateText(userText, from);

            // Enviamos la respuesta al usuario
            await sendWhatsAppMessage(from, response.message);

            // Si es un reclamo completo, lo guardamos en la base de datos
            if (response.isComplaint && 
                response.data?.citizenData?.name &&
                response.data?.citizenData?.documentId &&
                response.data?.citizenData?.address &&
                response.data?.type &&
                response.data?.description &&
                response.data?.location) {
              
              try {
                // Crear o actualizar ciudadano
                const citizen = await findOrCreateCitizen({
                  name: response.data.citizenData.name,
                  documentId: response.data.citizenData.documentId,
                  phone: from,
                  address: response.data.citizenData.address
                });

                // Crear el reclamo
                const complaint = await createComplaint({
                  type: response.data.type,
                  description: response.data.description,
                  location: response.data.location,
                  citizenId: citizen.id
                });

                // Enviar confirmación al usuario
                await sendWhatsAppMessage(
                  from,
                  `✅ Reclamo registrado exitosamente!\nNúmero de reclamo: #${complaint.id}\nTipo: ${complaint.type}\nEstado: Pendiente de revisión`
                );
              } catch (dbError) {
                console.error('Error saving to database:', dbError);
                await sendWhatsAppMessage(
                  from,
                  'Lo siento, hubo un problema al guardar tu reclamo. Por favor, intenta nuevamente.'
                );
              }
            }
          } catch (error) {
            console.error('Error al generar/responder mensaje:', error);
            await sendWhatsAppMessage(
              from,
              'Lo siento, ocurrió un error inesperado. Por favor, intenta más tarde.'
            );
          }
        } else {
          await sendWhatsAppMessage(
            msg.from,
            'Lo siento, en este momento solo puedo procesar mensajes de texto. ¿Podrías escribir tu mensaje, por favor?'
          );
        }
      }
    }
  });
}

/**
 * Envía un mensaje de texto a través de la API de WhatsApp (Cloud API).
 */
async function sendWhatsAppMessage(to: string, message: string) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to,
        text: {
          body: message,
        },
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
