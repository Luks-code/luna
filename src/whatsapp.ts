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
import { IntentType } from './types';

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
        await handleCommand(from, commandText, conversationState);
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

      // Procesar mensaje
      await processMessage(from, userText, conversationState, messageHistory);
    } catch (error) {
      console.error('Error al procesar mensaje:', error);
      await sendWhatsAppMessage(
        from,
        'Lo siento, ocurrió un error inesperado. Por favor, intenta más tarde.'
      );
    }
  });
}

export async function webhook(req: Request, res: Response) {
  try {
    const { body } = req;
    
    // Verificar si es un mensaje entrante de WhatsApp
    if (
      body.object === 'whatsapp_business_account' &&
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const from = body.entry[0].changes[0].value.messages[0].from;
      const userText = body.entry[0].changes[0].value.messages[0].text?.body;

      if (!userText) {
        console.log('Mensaje recibido sin texto, ignorando');
        return res.sendStatus(200);
      }

      console.log(`Mensaje recibido de ${from}: ${userText}`);

      // Procesar el mensaje (la función processMessage ahora obtiene el estado y el historial internamente)
      await processMessage(from, userText);

      return res.sendStatus(200);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error('Error en webhook:', error);
    return res.sendStatus(500);
  }
}

async function processMessage(from: string, message: string, conversationState?: any, messageHistory?: any) {
  // Verificar si es un comando
  if (message.startsWith('/')) {
    // Obtener el estado actual de la conversación si no se proporcionó
    if (!conversationState) {
      conversationState = await getConversationState(from);
      if (!conversationState) {
        conversationState = initialConversationState;
      }
    }
    return await handleCommand(from, message, conversationState);
  }

  // Obtener el estado actual de la conversación si no se proporcionó
  if (!conversationState) {
    conversationState = await getConversationState(from);
    if (!conversationState) {
      conversationState = initialConversationState;
    }
  }

  // Actualizar timestamp de última interacción
  conversationState.lastInteractionTimestamp = Date.now();

  // Añadir mensaje al historial
  await addMessageToHistory(from, 'user', message);

  // Obtener historial de mensajes si no se proporcionó
  if (!messageHistory) {
    messageHistory = await getMessageHistory(from);
  }

  // Generar respuesta con OpenAI
  const response = await generateText(message, conversationState, messageHistory);

  // Detectar la intención del usuario basado en la respuesta
  const newIntent = response.isComplaint ? IntentType.COMPLAINT : 
                   (message.toLowerCase().includes('hola') || message.toLowerCase().includes('buenos')) ? IntentType.GREETING :
                   (conversationState.isComplaintInProgress && !response.isComplaint) ? IntentType.INQUIRY :
                   IntentType.OTHER;

  // Actualizar el contexto de la conversación
  if (newIntent !== conversationState.currentIntent) {
    // Guardar la intención anterior
    conversationState.previousIntent = conversationState.currentIntent;
    
    // Si estábamos en medio de un reclamo y cambiamos a otra intención, marcar como interrumpido
    if (conversationState.currentIntent === IntentType.COMPLAINT && 
        conversationState.isComplaintInProgress && 
        newIntent !== IntentType.COMPLAINT) {
      conversationState.interruptedFlow = true;
      conversationState.interruptionContext = {
        originalIntent: IntentType.COMPLAINT,
        pendingQuestion: response.nextQuestion,
        resumePoint: conversationState.currentStep
      };
    }
    
    // Actualizar la intención actual
    conversationState.currentIntent = newIntent;
  }

  // Si hay un flujo interrumpido y volvemos a la intención original, restaurar el contexto
  if (conversationState.interruptedFlow && 
      newIntent === conversationState.interruptionContext?.originalIntent) {
    conversationState.interruptedFlow = false;
  }

  // Actualizar los temas de la conversación
  if (!conversationState.conversationTopics) {
    conversationState.conversationTopics = [];
  }
  
  // Extraer posible tema de la conversación (simplificado)
  const possibleTopic = message.split(' ').find(word => word.length > 5);
  if (possibleTopic && !conversationState.conversationTopics.includes(possibleTopic)) {
    conversationState.conversationTopics.push(possibleTopic);
  }

  // Actualizar campos pendientes si es un reclamo
  if (response.isComplaint) {
    const pendingFields = [];
    const complaintData = response.data || {};
    
    if (!complaintData.type) pendingFields.push('type');
    if (!complaintData.description) pendingFields.push('description');
    if (!complaintData.location) pendingFields.push('location');
    if (!complaintData.citizenData?.name) pendingFields.push('name');
    if (!complaintData.citizenData?.documentId) pendingFields.push('documentId');
    if (!complaintData.citizenData?.address) pendingFields.push('address');
    
    conversationState.pendingFields = pendingFields;
  }

  // Actualizar el estado de la conversación con los datos del reclamo
  if (response.isComplaint && response.data) {
    conversationState.isComplaintInProgress = true;
    
    // Actualizar el paso actual basado en los campos pendientes
    if (conversationState.pendingFields?.length === 0) {
      conversationState.currentStep = 'AWAITING_CONFIRMATION';
      conversationState.awaitingConfirmation = true;
    } else if (!conversationState.complaintData.type) {
      conversationState.currentStep = 'COLLECTING_TYPE';
    } else if (!conversationState.complaintData.description || !conversationState.complaintData.location) {
      conversationState.currentStep = 'COLLECTING_DESCRIPTION';
    } else {
      conversationState.currentStep = 'COLLECTING_CITIZEN_DATA';
    }

    // Actualizar los datos del reclamo
    conversationState.complaintData = {
      ...conversationState.complaintData,
      ...response.data,
      citizenData: {
        ...conversationState.complaintData.citizenData,
        ...response.data.citizenData
      }
    };
  }

  // Guardar el estado actualizado
  await setConversationState(from, conversationState);

  // Construir mensaje de respuesta
  let responseMessage = response.message || '';
  
  // Añadir información sobre el flujo interrumpido si es relevante
  if (conversationState.interruptedFlow && 
      conversationState.currentIntent === IntentType.COMPLAINT &&
      conversationState.previousIntent !== IntentType.COMPLAINT) {
    responseMessage += "\n\nVolvamos a tu reclamo anterior. ";
  }
  
  // Añadir la pregunta al final, evitando duplicación
  if (response.nextQuestion) {
    // Verificar si la pregunta ya está incluida en el mensaje
    const questionLowerCase = response.nextQuestion.toLowerCase();
    const messageLowerCase = responseMessage.toLowerCase();
    
    // Solo añadir la pregunta si no está ya incluida en el mensaje
    if (!messageLowerCase.includes(questionLowerCase)) {
      responseMessage += '\n\n' + response.nextQuestion;
    } else {
      console.log('Evitada duplicación de pregunta:', response.nextQuestion);
    }
  }

  // Enviar respuesta
  await sendWhatsAppMessage(from, responseMessage);

  // Añadir respuesta al historial
  await addMessageToHistory(from, 'assistant', responseMessage);

  // Si el estado es de confirmación, verificar si podemos guardar
  if (conversationState.awaitingConfirmation && isReadyToSave(conversationState.complaintData)) {
    conversationState.confirmedData = conversationState.complaintData;
    await setConversationState(from, conversationState);
  }
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
