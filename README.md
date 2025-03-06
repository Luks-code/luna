# Luna - Chatbot Municipal

Luna es un chatbot inteligente diseñado para atender consultas y gestionar reclamos municipales. Utiliza tecnología RAG (Retrieval Augmented Generation) con Pinecone para proporcionar respuestas precisas basadas en documentos oficiales.

## Tecnologías utilizadas

- Node.js y TypeScript
- Express para el servidor web
- OpenAI para generación de texto
- Pinecone para almacenamiento vectorial
- Upstash Redis para gestión de estado de conversaciones
- Prisma para la base de datos

## Despliegue en Render

### Requisitos previos

1. Cuenta en [Render](https://render.com/)
2. Cuenta en [Upstash Redis](https://upstash.com/)
3. Cuenta en [Pinecone](https://www.pinecone.io/)
4. Clave API de [OpenAI](https://platform.openai.com/)

### Pasos para el despliegue

1. **Conectar repositorio a Render**
   - Inicia sesión en Render
   - Haz clic en "New" y selecciona "Web Service"
   - Conecta tu repositorio de GitHub/GitLab
   - Selecciona la rama principal

2. **Configurar el servicio**
   - Nombre: `luna-agent` (o el que prefieras)
   - Runtime: `Node`
   - Build Command: `npm install && npx prisma generate`
   - Start Command: `npm run start-bot`

3. **Configurar variables de entorno**
   - `NODE_ENV`: `production`
   - `OPENAI_API_KEY`: Tu clave API de OpenAI
   - `PINECONE_API_KEY`: Tu clave API de Pinecone
   - `PINECONE_ENVIRONMENT`: `gcp-starter` (o el que corresponda)
   - `PINECONE_INDEX_NAME`: `municipalidad-info` (o el nombre de tu índice)
   - `UPSTASH_REDIS_REST_URL`: URL de tu base de datos Redis
   - `UPSTASH_REDIS_REST_TOKEN`: Token de acceso a Redis
   - `PORT`: `3000`

4. **Iniciar el despliegue**
   - Haz clic en "Create Web Service"
   - Render iniciará automáticamente el proceso de despliegue

### Verificación del despliegue

Una vez completado el despliegue, podrás acceder a tu chatbot a través de la URL proporcionada por Render. Deberías ver el mensaje: "Bot Municipal de Tafí Viejo corriendo 🚀"

## Configuración de Webhooks

Para integrar con WhatsApp u otras plataformas, configura los webhooks correspondientes apuntando a tu URL de Render + la ruta del webhook (por ejemplo: `https://tu-app.onrender.com/webhook`).

## Mantenimiento

Para actualizar el bot, simplemente haz push a tu repositorio conectado y Render desplegará automáticamente los cambios.
