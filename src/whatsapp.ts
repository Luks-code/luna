import { Express, Request, Response } from 'express';
import axios from 'axios';
import { generateText, isReadyToSave } from './textGenerator';
import { ConversationState, ConversationMode, ConversationMessage, GPTResponse, IntentType } from './types';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// Inicializar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'your-api-key',
});

// Caché simple para evitar llamadas repetidas a la API para mensajes idénticos
const intentClassificationCache: Map<string, any> = new Map();

import { findOrCreateCitizen, createComplaint } from './prisma';
import { 
  getConversationState, 
  setConversationState, 
  initialConversationState,
  getMessageHistory,
  addMessageToHistory,
  deleteConversation,
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

      // Manejar confirmación si está pendiente
      if (conversationState.awaitingConfirmation || conversationState.confirmationRequested) {
        const upperText = userText.toUpperCase();
        if (upperText === 'CONFIRMAR') {
          // Guardar el reclamo y reiniciar el estado
          await saveComplaint(from, conversationState.complaintData);
          
          // Asegurarse de que el estado se ha reiniciado completamente
          await deleteConversation(from);
          
          return;
        } else if (upperText === 'CANCELAR') {
          // Mensaje de cancelación
          const cancelMessage = 'Reclamo cancelado.';
          await sendWhatsAppMessage(from, cancelMessage);
          await addMessageToHistory(from, 'assistant', cancelMessage);
          
          // Mensaje de reinicio
          const resetMessage = 'La conversación ha sido reiniciada.';
          await sendWhatsAppMessage(from, resetMessage);
          
          // Eliminar completamente la conversación
          const deleted = await deleteConversation(from);
          console.log(`Conversación eliminada: ${deleted ? 'Sí' : 'No'}`);
          
          return;
        } else {
          const promptMessage = 'Por favor, responde únicamente CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo. Al confirmar, aceptas que tus datos personales sean compartidos con la municipalidad y almacenados en nuestra base de datos para la gestión de tu reclamo.';
          await sendWhatsAppMessage(from, promptMessage);
          await addMessageToHistory(from, 'assistant', promptMessage);
          return;
        }
      }
      
      // Detectar intenciones de cancelación en mensajes normales cuando hay un reclamo en progreso
      if (conversationState.isComplaintInProgress && await detectCancellationIntent(userText)) {
        console.log('Intención de cancelación detectada en mensaje normal');
        
        // Mensaje de cancelación
        const cancelMessage = 'He detectado que deseas cancelar el reclamo actual.';
        await sendWhatsAppMessage(from, cancelMessage);
        await addMessageToHistory(from, 'assistant', cancelMessage);
        
        // Mensaje de reinicio
        const resetMessage = 'La conversación ha sido reiniciada.';
        await sendWhatsAppMessage(from, resetMessage);
        
        // Eliminar completamente la conversación
        const deleted = await deleteConversation(from);
        console.log(`Conversación eliminada: ${deleted ? 'Sí' : 'No'}`);
        
        return;
      }

      // Manejar comandos especiales
      if (userText.startsWith('/')) {
        const commandText = userText.substring(1);
        // Añadir el comando al historial (solo una vez)
        await addMessageToHistory(from, 'user', userText);
        await handleCommand(from, commandText, conversationState);
        return;
      }

      // Añadir el mensaje del usuario al historial (solo una vez)
      await addMessageToHistory(from, 'user', userText);

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

// Función para detectar intención de cancelación usando IA
async function detectCancellationIntent(message: string): Promise<boolean> {
  console.log('[Luna] Verificando intención de cancelación usando IA para:', message);
  
  try {
    // Verificar si hay una entrada en caché para este mensaje
    const cacheKey = `cancel_${message.toLowerCase().trim()}`;
    if (intentClassificationCache.has(cacheKey)) {
      console.log('[Luna] Usando resultado en caché para intención de cancelación');
      const cachedResult = intentClassificationCache.get(cacheKey);
      return cachedResult === true;
    }
    
    // Usar la API de OpenAI para clasificar si el mensaje expresa intención de cancelación
    const prompt = `
Analiza el siguiente mensaje y determina si expresa una intención clara de cancelar o abandonar un proceso de reclamo municipal en curso.
Ejemplos de intenciones de cancelación incluyen: querer cancelar el reclamo, detener el proceso, no continuar con la queja, etc.

Mensaje: "${message}"

Responde con un JSON en el siguiente formato:
{
  "isCancellation": true/false,
  "confidence": 0.0-1.0
}
`;

    // Llamar a la API
    const apiMessages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: prompt
      }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: apiMessages,
      response_format: { type: 'json_object' },
      max_tokens: 150,
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    
    // Guardar en caché para futuras consultas
    intentClassificationCache.set(cacheKey, result.isCancellation === true);
    
    if (result.isCancellation) {
      console.log(`[Luna] Detectada intención de cancelación (confianza: ${result.confidence})`);
    }
    
    return result.isCancellation === true;
  } catch (error) {
    console.error('[Luna] Error al detectar intención de cancelación:', error);
    return false;
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
    return await handleCommand(from, message.substring(1), conversationState);
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

  // Añadir mensaje al historial SOLO si no fue llamado desde el webhook
  // que ya lo añadió previamente
  if (!messageHistory) {
    // Si no se proporcionó historial, asumimos que esta función fue llamada directamente
    // y necesitamos añadir el mensaje al historial
    await addMessageToHistory(from, 'user', message);
    messageHistory = await getMessageHistory(from);
  }

  // Verificar si estamos en estado de confirmación de reclamo
  if ((conversationState.awaitingConfirmation || conversationState.confirmationRequested) && 
      conversationState.mode === ConversationMode.COMPLAINT && 
      isReadyToSave(conversationState.complaintData)) {
    
    // Normalizar el mensaje para comparación
    const normalizedMessage = message.toLowerCase().trim();
    
    let responseMessage = "";
    
    // Solo aceptar "confirmar" o "cancelar" como entradas válidas
    if (normalizedMessage === 'confirmar') {
      // Guardar el reclamo
      conversationState.confirmedData = conversationState.complaintData;
      await setConversationState(from, conversationState);
      
      try {
        const complaintId = await saveComplaint(from, conversationState.complaintData);
        responseMessage = `¡Gracias! Tu reclamo ha sido registrado exitosamente con el número #${complaintId}. Te notificaremos cuando haya novedades. ¿Hay algo más en lo que pueda ayudarte?`;
        
        // Reiniciar el estado del reclamo
        conversationState.isComplaintInProgress = false;
        conversationState.awaitingConfirmation = false;
        conversationState.confirmationRequested = false;
        conversationState.mode = ConversationMode.DEFAULT;
        conversationState.complaintData = {};
      } catch (error) {
        console.error('Error al guardar el reclamo:', error);
        responseMessage = "Lo siento, hubo un problema al guardar tu reclamo. Por favor, intenta nuevamente más tarde.";
      }
    } else if (normalizedMessage === 'cancelar') {
      // Cancelar el reclamo
      responseMessage = "He cancelado el registro del reclamo. Todos los datos ingresados han sido descartados. ¿Puedo ayudarte con algo más?";
      
      // Reiniciar el estado del reclamo
      conversationState.isComplaintInProgress = false;
      conversationState.awaitingConfirmation = false;
      conversationState.confirmationRequested = false;
      conversationState.mode = ConversationMode.DEFAULT;
      conversationState.complaintData = {};
    } else {
      // Cualquier otra entrada no es válida
      responseMessage = "Por favor, responde únicamente CONFIRMAR para guardar el reclamo o CANCELAR para descartarlo. Al confirmar, aceptas que tus datos personales sean compartidos con la municipalidad y almacenados en nuestra base de datos para la gestión de tu reclamo.";
    }
    
    // Guardar el estado actualizado
    await setConversationState(from, conversationState);
    
    // Enviar respuesta
    await sendWhatsAppMessage(from, responseMessage);
    
    // Añadir respuesta al historial
    await addMessageToHistory(from, 'assistant', responseMessage);
    
    return;
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
        resumePoint: conversationState.currentStep
      };
    }
    
    // Actualizar la intención actual
    conversationState.currentIntent = newIntent;
    
    // Si cambiamos de COMPLAINT a INQUIRY, es posible que necesitemos cambiar a modo INFO
    if (conversationState.currentIntent === IntentType.INQUIRY && 
        conversationState.previousIntent === IntentType.COMPLAINT &&
        conversationState.mode === ConversationMode.COMPLAINT) {
      // Verificar si el mensaje parece una consulta informativa
      if (await isLikelyInformationQuery(message)) {
        console.log('[Luna] Cambiando temporalmente a modo INFO desde COMPLAINT');
        conversationState.previousMode = conversationState.mode;
        conversationState.mode = ConversationMode.INFO;
        conversationState.modeChangeMessageSent = false;
      }
    }
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

  // Actualizar el modo de conversación basado en la respuesta
  if (response.isComplaint && conversationState.mode !== ConversationMode.COMPLAINT) {
    // Si detectamos un reclamo y no estamos en modo COMPLAINT, cambiar al modo COMPLAINT
    conversationState.previousMode = conversationState.mode;
    conversationState.mode = ConversationMode.COMPLAINT;
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
    
    // Log para depuración
    console.log('[Luna] Datos del reclamo actualizados:', JSON.stringify(conversationState.complaintData, null, 2));
    
    // Verificar si la dirección se actualizó correctamente
    if (response.data?.citizenData?.address) {
      console.log(`[Luna] Dirección actualizada: ${response.data.citizenData.address}`);
    }
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
  
  // Añadir información sobre el cambio de modo si es relevante
  if (conversationState.mode === ConversationMode.COMPLAINT && 
      !conversationState.modeChangeMessageSent &&
      // No mostrar el mensaje si estamos volviendo de modo INFO a COMPLAINT
      !(conversationState.previousMode === ConversationMode.INFO && conversationState.interruptedFlow)) {
    // Si estamos en modo COMPLAINT y no se ha enviado el mensaje, mostrarlo
    responseMessage = "[RECLAMO] " + responseMessage;
    // Marcar que ya se envió el mensaje de cambio de modo
    conversationState.modeChangeMessageSent = true;
  } else if (conversationState.mode === ConversationMode.INFO && 
             !conversationState.modeChangeMessageSent) {
    // Si estamos en modo INFO y no se ha enviado el mensaje, mostrarlo
    responseMessage = "[INFO] " + responseMessage;
    // Marcar que ya se envió el mensaje de cambio de modo
    conversationState.modeChangeMessageSent = true;
    
    // Si venimos de un reclamo, marcarlo como flujo interrumpido para poder volver después
    if (conversationState.previousMode === ConversationMode.COMPLAINT && 
        conversationState.isComplaintInProgress && 
        !conversationState.interruptedFlow) {
      conversationState.interruptedFlow = true;
      conversationState.interruptionContext = {
        originalIntent: IntentType.COMPLAINT,
        resumePoint: conversationState.currentStep
      };
    }
  }
  
  // Enviar respuesta
  await sendWhatsAppMessage(from, responseMessage);

  // Añadir respuesta al historial
  await addMessageToHistory(from, 'assistant', responseMessage);

  // Si el estado es de confirmación, verificar si podemos guardar
  if ((conversationState.awaitingConfirmation || conversationState.confirmationRequested) && isReadyToSave(conversationState.complaintData)) {
    conversationState.confirmedData = conversationState.complaintData;
    // Asegurar que ambos flags estén sincronizados
    conversationState.awaitingConfirmation = true;
    conversationState.confirmationRequested = true;
    await setConversationState(from, conversationState);
  }
}

async function saveComplaint(from: string, complaintData: any) {
  try {
    console.log('Intentando guardar reclamo con datos:', JSON.stringify(complaintData, null, 2));
    
    if (!complaintData?.citizenData?.name || !complaintData?.citizenData?.documentId) {
      throw new Error('Datos de ciudadano incompletos');
    }
    
    const citizen = await findOrCreateCitizen({
      name: complaintData.citizenData.name,
      documentId: complaintData.citizenData.documentId,
      phone: from,
      address: complaintData.citizenData.address || 'No especificada'
    });

    console.log('Ciudadano encontrado/creado:', citizen);

    if (!complaintData.type || !complaintData.description || !complaintData.location) {
      throw new Error('Datos del reclamo incompletos');
    }

    const complaint = await createComplaint({
      type: complaintData.type,
      description: complaintData.description,
      location: complaintData.location,
      citizenId: citizen.id
    });

    console.log('Reclamo creado:', complaint);

    // Crear el mensaje de confirmación
    const confirmationMessage = `✅ Reclamo registrado exitosamente!\nNúmero de reclamo: #${complaint.id}\nTipo: ${complaint.type}\nEstado: Pendiente de revisión`;
    
    await sendWhatsAppMessage(from, confirmationMessage);
    await addMessageToHistory(from, 'assistant', confirmationMessage);

    await sendWhatsAppMessage(from, "La conversación será reiniciada.");
    await addMessageToHistory(from, 'assistant', "La conversación será reiniciada.");

    // Eliminar completamente la conversación
    const deleted = await deleteConversation(from);
    console.log(`Conversación eliminada después de guardar reclamo: ${deleted ? 'Sí' : 'No'}`);

    return true;
  } catch (error) {
    console.error('Error al guardar reclamo:', error);
    
    let errorMessage = 'Lo siento, ocurrió un error al guardar tu reclamo.';
    
    // Personalizar mensaje según el tipo de error
    if (error instanceof Error) {
      if (error.message.includes('Datos de ciudadano incompletos')) {
        errorMessage = 'No se pudo guardar el reclamo porque faltan datos personales. Por favor, proporciona tu nombre completo y número de documento.';
      } else if (error.message.includes('Datos del reclamo incompletos')) {
        errorMessage = 'No se pudo guardar el reclamo porque faltan datos del problema. Por favor, proporciona el tipo, descripción y ubicación del problema.';
      } else if (error.message.includes('Unique constraint failed')) {
        errorMessage = 'Hubo un problema con tus datos de contacto. Por favor, intenta nuevamente o contacta con soporte técnico.';
      }
    }
    
    await sendWhatsAppMessage(from, errorMessage);
    await addMessageToHistory(from, 'assistant', errorMessage);
    
    return false;
  }
}

// Función para determinar si un mensaje es probablemente una consulta informativa usando IA
async function isLikelyInformationQuery(message: string): Promise<boolean> {
  console.log('[Luna] Verificando si el mensaje es una consulta informativa usando IA');
  
  try {
    // Verificar si hay una entrada en caché para este mensaje
    const cacheKey = `info_${message.toLowerCase().trim()}`;
    if (intentClassificationCache.has(cacheKey)) {
      console.log('[Luna] Usando resultado en caché para clasificación de consulta informativa');
      const cachedResult = intentClassificationCache.get(cacheKey);
      return cachedResult === true;
    }
    
    // Usar la API de OpenAI para clasificar si el mensaje es una consulta informativa
    const prompt = `
Analiza el siguiente mensaje y determina si es una consulta informativa (pregunta que busca información).
Las consultas informativas suelen incluir preguntas sobre horarios, ubicaciones, requisitos, procedimientos, etc.

Mensaje: "${message}"

Responde con un JSON en el siguiente formato:
{
  "isInformationQuery": true/false,
  "confidence": 0.0-1.0
}
`;

    // Llamar a la API
    const apiMessages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: prompt
      }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: apiMessages,
      response_format: { type: 'json_object' },
      max_tokens: 150,
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    
    // Guardar en caché para futuras consultas
    intentClassificationCache.set(cacheKey, result.isInformationQuery === true);
    
    if (result.isInformationQuery) {
      console.log(`[Luna] Detectada consulta informativa (confianza: ${result.confidence})`);
    }
    
    return result.isInformationQuery === true;
  } catch (error) {
    console.error('[Luna] Error al detectar consulta informativa:', error);
    return false;
  }
}
