// index.ts
import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { setupWhatsAppWebhook } from './whatsapp';
import { setConversationState, getConversationState, initialConversationState } from './redis';

const app = express();
const PORT = process.env.PORT || 3000;

// Para que Express pueda parsear JSON en el body de las peticiones
app.use(bodyParser.json());

// Ruta simple de prueba
app.get('/', (req: Request, res: Response) => {
  res.send('Bot Municipal de Tafí Viejo corriendo 🚀');
});

// Ruta de prueba para Redis
app.get('/test-redis', async (req: Request, res: Response) => {
  try {
    console.log('Probando conexión con Redis...');
    
    // Intentar guardar un estado
    await setConversationState('test-phone', initialConversationState);
    console.log('Estado guardado');
    
    // Intentar recuperar el estado
    const state = await getConversationState('test-phone');
    console.log('Estado recuperado:', state);
    
    res.json({ success: true, state });
  } catch (error: any) {
    console.error('Error en prueba de Redis:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoints de prueba para Redis TTL
app.post('/test/conversation-state', async (req, res) => {
  const testPhone = 'test-phone-123';
  
  try {
    // Guardar estado inicial
    await setConversationState(testPhone, {
      ...initialConversationState,
      complaintData: { type: 'TEST_COMPLAINT' }
    });
    
    // Verificar que se guardó
    const initial = await getConversationState(testPhone);
    
    // Esperar 5 segundos y verificar que aún existe
    await new Promise(resolve => setTimeout(resolve, 5000));
    const afterFiveSeconds = await getConversationState(testPhone);
    
    res.json({
      message: 'Test en progreso. El estado expirará en 10 minutos.',
      initialState: initial,
      stateAfter5Seconds: afterFiveSeconds
    });
  } catch (error) {
    res.status(500).json({ error: 'Error en el test' });
  }
});

app.get('/test/conversation-state/:phone', async (req, res) => {
  try {
    const state = await getConversationState(req.params.phone);
    res.json({
      exists: !!state,
      state: state
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estado' });
  }
});

// Configuramos las rutas para el Webhook de WhatsApp
setupWhatsAppWebhook(app);

// Iniciamos el servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
