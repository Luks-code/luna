// whatsapp.ts
import { Express, Request, Response } from 'express';
import axios from 'axios';
import generateText from './textGenerator';

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
    // Aseguramos responder 200 rápido a Meta para no generar errores
    // y luego procesar la lógica.
    res.sendStatus(200);

    const body = req.body;

    // Verificamos que el evento venga con la estructura esperada
    if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0]) {
      const changes = body.entry[0].changes[0];
      const value = changes.value;
      const messages = value.messages;

      // Chequeamos si hay mensajes
      if (messages && messages.length > 0) {
        const msg = messages[0];
        const from = msg.from; // Número del usuario que envía el mensaje
        const textType = msg.type;

        // Si el mensaje es de tipo texto
        if (textType === 'text') {
          const userText = msg.text.body; // Texto que envía el ciudadano

          try {
            // Generamos la respuesta con OpenAI (o la lógica que desees)
            const responseText = await generateText(userText);

            // Respondemos al usuario
            await sendWhatsAppMessage(from, responseText);
          } catch (error) {
            console.error('Error al generar/responder mensaje:', error);
          }
        } else {
          // En caso de que no sea texto (ej. audio, imagen), podrías manejarlo distinto:
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
