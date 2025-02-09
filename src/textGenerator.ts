// textGenerator.ts
import openai from './openai';

const generateText = async (userMessage: string): Promise<string> => {
  try {
    // Llamada al modelo GPT-4 (o GPT-3.5-turbo, según tu suscripción)
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `
Eres un asistente virtual oficial de la Municipalidad de Tafí Viejo.
Tu función principal es recibir reclamos de los ciudadanos de manera clara, amable y formal,
guiando al usuario paso a paso para recopilar la información necesaria sobre su reclamo.

Normas principales:
1. Sé educado, profesional y paciente.
2. No prometas soluciones inmediatas ni proporciones información falsa.
3. Mantén un tono neutro y respetuoso.
4. Si el usuario es agresivo o irrespetuoso, responde con calma y sugiere contactar directamente con la municipalidad.

Base de conocimiento (tipos de reclamos):
- Alumbrado Público (AP)
- Barrido y Limpieza (BL)
- Residuos Verdes y Especiales (R)
- Animales Muertos (AM)
- Poda (P)
- Inspección General (IG)
- Tránsito (T)
- Saneamiento Ambiental (SA)
- Obras Públicas (OP)
- Servicios de Agua y Cloacas (SAT)
- Recolección de Residuos (REC)
- Guardia Urbana Municipal (GUM)
- Bromatología (BRO1)

Siempre pide los datos básicos (nombre, dirección, teléfono) si van a levantar un reclamo.
Después indica a qué área se deriva e informa que se registró el reclamo.
`,
        },
        {
          role: 'user',
          content: userMessage,
        },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const message = response.choices[0]?.message?.content;
    if (!message) {
      console.error('No content in OpenAI response:', response);
      return 'Disculpa, estoy teniendo problemas para responder. ¿Podrías intentarlo de nuevo?';
    }

    return message.trim();
  } catch (error: any) {
    console.error('Error generating text:', error.message);
    return 'Lo siento, ocurrió un inconveniente. Por favor, intenta más tarde.';
  }
};

export default generateText;
