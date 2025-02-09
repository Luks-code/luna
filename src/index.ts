// index.ts
import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { setupWhatsAppWebhook } from './whatsapp';

const app = express();
const PORT = process.env.PORT || 3000;

// Para que Express pueda parsear JSON en el body de las peticiones
app.use(bodyParser.json());

// Ruta simple de prueba
app.get('/', (req: Request, res: Response) => {
  res.send('Bot Municipal de Tafí Viejo corriendo 🚀');
});

// Configuramos las rutas para el Webhook de WhatsApp
setupWhatsAppWebhook(app);

// Iniciamos el servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
