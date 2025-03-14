import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import * as dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { ingestDocument } from '../src/rag/ingestPinecone';

// Cargar variables de entorno
dotenv.config();

// Configuración
const MUNICIPAL_WEBSITE = 'https://www.tafiviejo.gob.ar';
const MAX_PAGES = 50;
const MAX_DEPTH = 3;
const OUTPUT_DIR = path.join(__dirname, '../data/documents/municipio');
const PROCESSED_DIR = path.join(__dirname, '../data/documents/procesados');

// Cliente de OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Cola de URLs a visitar
const urlQueue: { url: string; depth: number }[] = [];
const visitedUrls = new Set<string>();

// Función para normalizar URLs
function normalizeUrl(url: string): string {
  // Eliminar parámetros de consulta y fragmentos
  return url.split('?')[0].split('#')[0];
}

// Función para convertir URL a nombre de archivo
function urlToFilename(url: string): string {
  // Eliminar protocolo y dominio
  let filename = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  
  // Reemplazar caracteres no válidos para nombres de archivo
  filename = filename.replace(/[\\/:*?"<>|]/g, '_');
  
  // Añadir extensión
  return filename + '.txt';
}

// Función para determinar la categoría de una página
function determineCategory(url: string, title: string, content: string): string {
  // Categorías basadas en URL
  if (url.includes('/tramites')) return 'tramites';
  if (url.includes('/servicios')) return 'servicios';
  if (url.includes('/contacto')) return 'contacto';
  if (url.includes('/noticias') || url.includes('/noticia')) return 'noticias';
  if (url.includes('/turismo')) return 'turismo';
  if (url.includes('/cultura')) return 'cultura';
  if (url.includes('/deporte')) return 'deporte';
  if (url.includes('/salud')) return 'salud';
  if (url.includes('/educacion')) return 'educacion';
  if (url.includes('/institucional')) return 'institucional';
  if (url.includes('/gobierno')) return 'gobierno';
  
  // Categorías basadas en título
  const titleLower = title.toLowerCase();
  if (titleLower.includes('trámite') || titleLower.includes('tramite')) return 'tramites';
  if (titleLower.includes('servicio')) return 'servicios';
  if (titleLower.includes('contacto')) return 'contacto';
  if (titleLower.includes('noticia')) return 'noticias';
  
  // Categoría por defecto
  return 'general';
}

// Función para scrapear una página
async function scrapePage(url: string, depth: number): Promise<{ content: string; links: string[]; metadata: any }> {
  console.log(`[${depth}] Scrapeando ${url}...`);
  
  try {
    const browser = await puppeteer.launch({
      headless: true,
    });
    const page = await browser.newPage();
    
    // Navegar a la URL
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Extraer contenido
    const content = await page.evaluate(() => {
      // Función para limpiar texto
      const cleanText = (text: string) => {
        return text
          .replace(/\s+/g, ' ')
          .replace(/\n+/g, '\n')
          .trim();
      };
      
      // Obtener el contenido principal
      const mainContent = document.body.innerText;
      return cleanText(mainContent);
    });
    
    // Extraer título
    const title = await page.title();
    
    // Extraer enlaces internos
    const links = await page.evaluate((baseUrl) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .map(a => a.getAttribute('href'))
        .filter(href => href && !href.startsWith('#') && !href.startsWith('javascript:'))
        .map(href => {
          if (href && href.startsWith('/')) {
            return new URL(href, baseUrl).href;
          }
          return href;
        })
        .filter(href => href && href.startsWith(baseUrl));
    }, MUNICIPAL_WEBSITE);
    
    await browser.close();
    
    // Determinar categoría
    const category = determineCategory(url, title, content);
    
    return {
      content,
      links: links as string[],
      metadata: {
        title,
        url,
        category,
        depth,
      },
    };
  } catch (error) {
    console.error(`Error al scrapear ${url}:`, error);
    return { content: '', links: [], metadata: {} };
  }
}

// Función para procesar el contenido con ChatGPT
async function processWithChatGPT(content: string, metadata: any, url: string): Promise<{processedContent: string, isRelevant: boolean}> {
  if (!content || content.trim().length < 100) {
    console.log(`Contenido insuficiente en ${url}, omitiendo procesamiento`);
    return {processedContent: '', isRelevant: false};
  }
  
  console.log(`Procesando contenido de "${metadata.title}" (${metadata.category}) con ChatGPT...`);
  
  const prompt = `
  Eres un asistente especializado en estructurar información municipal para un sistema RAG (Retrieval Augmented Generation).
  
  Por favor, analiza la siguiente información extraída de la página web municipal de Tafí Viejo:
  
  1. PRIMERO, evalúa si esta información es RELEVANTE para consultas ciudadanas sobre trámites, servicios, contactos, o información municipal importante.
  2. Si la información es principalmente sobre noticias, eventos pasados, o contenido no relevante para trámites o servicios municipales, responde con "NO_RELEVANTE" al inicio de tu respuesta.
  3. Si la información ES RELEVANTE (contiene datos sobre trámites, servicios, horarios, requisitos, contactos, etc.), estructura el contenido de la siguiente manera:
     - Elimina información irrelevante, menús, elementos de navegación o texto duplicado
     - Organiza el contenido en secciones lógicas con títulos claros
     - Destaca claramente requisitos, horarios, ubicaciones, contactos y cualquier dato importante
     - Si hay trámites o servicios mencionados, estructura la información en:
       * Descripción del trámite/servicio
       * Requisitos necesarios
       * Pasos a seguir
       * Horarios y lugares de atención
       * Contactos relacionados
     - Si el contenido es muy extenso, resume la información manteniendo todos los datos importantes
  4. Usa un formato simple y claro, sin markdown ni formato especial
  
  URL: ${url}
  Título: ${metadata.title}
  Categoría: ${metadata.category}
  
  Contenido:
  ${content.substring(0, 15000)} // Limitar tamaño para evitar exceder límites de tokens
  `;
  
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4000,
    });
    
    const responseContent = response.choices[0]?.message?.content || '';
    
    // Verificar si el contenido es relevante
    const isRelevant = !responseContent.trim().startsWith('NO_RELEVANTE');
    
    if (!isRelevant) {
      console.log(`Contenido no relevante detectado en: ${url}`);
      return {processedContent: '', isRelevant: false};
    }
    
    // Añadir metadatos al principio del documento
    const processedContent = `TÍTULO: ${metadata.title}
URL: ${url}
CATEGORÍA: ${metadata.category}
FECHA: ${new Date().toISOString()}

${responseContent}`;
    
    return {processedContent, isRelevant: true};
  } catch (error) {
    console.error(`Error al procesar con ChatGPT:`, error);
    return {processedContent: '', isRelevant: false};
  }
}

// Función para ingestar un documento procesado
async function ingestProcessedDocument(filePath: string): Promise<boolean> {
  try {
    return await ingestDocument(filePath);
  } catch (error) {
    console.error(`Error al ingestar documento ${filePath}:`, error);
    return false;
  }
}

// Función principal
async function main() {
  // Crear directorios de salida si no existen
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  if (!fs.existsSync(PROCESSED_DIR)) {
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  }
  
  // Comenzar con la página principal
  urlQueue.push({ url: MUNICIPAL_WEBSITE, depth: 0 });
  
  let processedCount = 0;
  let ingestedCount = 0;
  let skippedCount = 0;
  
  // Procesar la cola de URLs
  while (urlQueue.length > 0 && visitedUrls.size < MAX_PAGES) {
    const { url: currentUrl, depth } = urlQueue.shift()!;
    const normalizedUrl = normalizeUrl(currentUrl);
    
    // Saltar si ya visitamos esta URL o excede la profundidad máxima
    if (visitedUrls.has(normalizedUrl) || depth > MAX_DEPTH) {
      continue;
    }
    
    // Marcar como visitada
    visitedUrls.add(normalizedUrl);
    
    // Scrapear la página
    const { content, links, metadata } = await scrapePage(normalizedUrl, depth);
    
    if (content) {
      // Guardar contenido raw (solo para referencia)
      const rawFilename = path.join(OUTPUT_DIR, urlToFilename(normalizedUrl));
      fs.writeFileSync(rawFilename, content);
      
      // Procesar con ChatGPT y verificar relevancia
      const { processedContent, isRelevant } = await processWithChatGPT(content, metadata, normalizedUrl);
      
      if (processedContent && isRelevant) {
        // Guardar contenido procesado
        const processedFilename = path.join(PROCESSED_DIR, urlToFilename(normalizedUrl));
        fs.writeFileSync(processedFilename, processedContent);
        console.log(`Contenido relevante procesado y guardado en ${processedFilename}`);
        processedCount++;
        
        // Ingestar automáticamente
        const ingestResult = await ingestProcessedDocument(processedFilename);
        if (ingestResult) {
          ingestedCount++;
          console.log(`Documento relevante ingresado exitosamente: ${processedFilename}`);
        }
      } else {
        console.log(`Omitiendo página no relevante: ${normalizedUrl}`);
        skippedCount++;
      }
      
      // Añadir enlaces a la cola
      for (const link of links) {
        if (!visitedUrls.has(link)) {
          urlQueue.push({ url: link, depth: depth + 1 });
        }
      }
      
      // Pequeña pausa para evitar sobrecargar el servidor
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`Proceso completado. Se procesaron ${processedCount} páginas relevantes de ${visitedUrls.size} visitadas.`);
  console.log(`Páginas omitidas por no ser relevantes: ${skippedCount}`);
  console.log(`Documentos ingestados: ${ingestedCount}`);
  console.log(`Contenido raw guardado en: ${OUTPUT_DIR}`);
  console.log(`Contenido procesado relevante guardado en: ${PROCESSED_DIR}`);
}

// Ejecutar si se llama directamente
if (require.main === module) {
  main().catch(console.error);
}
