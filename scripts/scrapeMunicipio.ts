import * as puppeteer from 'puppeteer';
import { OpenAI } from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import { ingestDocument } from '../src/rag/ingest';

// Cargar variables de entorno
dotenv.config();

// Configuración
const MUNICIPAL_WEBSITE = 'https://www.tafiviejo.gob.ar';
const MAX_PAGES = 50; // Límite de páginas para evitar scraping excesivo
const MAX_DEPTH = 3; // Profundidad máxima de navegación
const OUTPUT_DIR = path.join(__dirname, '../data/documents/municipio');
const PROCESSED_DIR = path.join(__dirname, '../data/documents/procesados');

// Inicializar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Conjunto para rastrear URLs ya visitadas
const visitedUrls = new Set<string>();
// Cola de URLs por visitar con su profundidad
const urlQueue: Array<{url: string, depth: number}> = [];

// Función para normalizar URLs
function normalizeUrl(pageUrl: string): string {
  // Convertir a URL absoluta
  const absoluteUrl = new URL(pageUrl, MUNICIPAL_WEBSITE).href;
  // Eliminar parámetros de consulta y fragmentos
  return absoluteUrl.split('?')[0].split('#')[0];
}

// Función para verificar si una URL pertenece al dominio municipal
function isInternalUrl(pageUrl: string): boolean {
  try {
    const urlObj = new URL(pageUrl, MUNICIPAL_WEBSITE);
    return urlObj.hostname === new URL(MUNICIPAL_WEBSITE).hostname;
  } catch (error) {
    return false;
  }
}

// Función para generar un nombre de archivo seguro basado en la URL
function urlToFilename(pageUrl: string): string {
  const urlPath = new URL(pageUrl).pathname;
  // Crear un nombre basado en la ruta de la URL
  let filename = urlPath.replace(/^\/|\/$/g, '').replace(/\//g, '_');
  
  // Si está vacío (página principal) o es demasiado largo, usar un hash
  if (!filename || filename.length > 100) {
    const hash = crypto.createHash('md5').update(pageUrl).digest('hex').substring(0, 8);
    filename = filename ? `${filename.substring(0, 50)}_${hash}` : `home_${hash}`;
  }
  
  return `${filename}.txt`;
}

// Función para extraer metadatos de la página
async function extractMetadata(page: puppeteer.Page): Promise<{title: string, category: string}> {
  return page.evaluate(() => {
    const title = document.title || 'Sin título';
    
    // Intentar determinar la categoría basada en la estructura de la página
    let category = 'general';
    
    // Buscar palabras clave en la URL o título para categorizar
    const pageUrl = window.location.pathname.toLowerCase();
    const pageTitle = document.title.toLowerCase();
    
    const categoryKeywords: {[key: string]: string[]} = {
      'tramites': ['tramite', 'tramites', 'procedimiento', 'solicitud'],
      'servicios': ['servicio', 'servicios', 'prestacion'],
      'contacto': ['contacto', 'contactenos', 'telefono', 'email', 'direccion'],
      'noticias': ['noticia', 'noticias', 'novedad', 'novedades', 'actualidad'],
      'impuestos': ['impuesto', 'impuestos', 'tasa', 'tasas', 'tributo', 'pago'],
      'obras': ['obra', 'obras', 'infraestructura', 'construccion'],
      'cultura': ['cultura', 'cultural', 'evento', 'eventos', 'teatro', 'museo'],
      'turismo': ['turismo', 'turistico', 'visitar', 'atractivo'],
      'salud': ['salud', 'hospital', 'clinica', 'medico', 'sanitario']
    };
    
    // Determinar categoría basada en palabras clave
    for (const [cat, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.some(keyword => pageUrl.includes(keyword) || pageTitle.includes(keyword))) {
        category = cat;
        break;
      }
    }
    
    return { title, category };
  });
}

// Función para scrapear una URL y extraer enlaces internos
async function scrapePage(pageUrl: string, depth: number): Promise<{content: string, links: string[], metadata: any}> {
  console.log(`[${depth}] Scrapeando ${pageUrl}...`);
  
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Extraer metadatos
    const metadata = await extractMetadata(page);
    
    // Extraer el contenido principal
    const content = await page.evaluate(() => {
      // Intentar encontrar el contenido principal
      const contentSelectors = [
        'main', 
        'article', 
        '.content', 
        '.main-content', 
        '#content',
        '.container'
      ];
      
      let mainElement: Element | null = null;
      for (const selector of contentSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent && element.textContent.trim().length > 100) {
          mainElement = element;
          break;
        }
      }
      
      // Si no se encuentra un contenedor específico, usar el body
      const contentElement = mainElement || document.body;
      
      // Eliminar elementos no deseados
      const elementsToRemove = contentElement.querySelectorAll('nav, footer, header, script, style, .menu, .navigation, .sidebar, .footer, .header');
      elementsToRemove.forEach(el => el.remove());
      
      return contentElement.textContent || '';
    });
    
    // Extraer todos los enlaces internos
    const links = await page.evaluate((baseUrl) => {
      const allLinks = Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.getAttribute('href'))
        .filter(href => href !== null && !href.startsWith('#') && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:'))
        .map(href => href as string); // Asegurar que href no es null
      
      // Convertir a URLs absolutas
      return allLinks.map(href => new URL(href, window.location.href).href);
    }, MUNICIPAL_WEBSITE);
    
    // Filtrar solo enlaces internos
    const internalLinks = links.filter(link => isInternalUrl(link)).map(link => normalizeUrl(link));
    
    await browser.close();
    return { content, links: internalLinks, metadata };
  } catch (error) {
    console.error(`Error al scrapear ${pageUrl}:`, error);
    await browser.close();
    return { content: '', links: [], metadata: { title: 'Error', category: 'error' } };
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

// Función para ingestar automáticamente un documento
async function ingestProcessedDocument(filePath: string): Promise<boolean> {
  try {
    console.log(`Ingiriendo documento: ${filePath}`);
    const result = await ingestDocument(filePath);
    return result;
  } catch (error) {
    console.error(`Error al ingerir documento ${filePath}:`, error);
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
