import { queryDocuments } from './query';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Script para probar la funcionalidad de RAG
 * Uso: ts-node src/rag/test.ts "¿Cómo obtener una habilitación comercial?"
 */
async function testRAG() {
  // Obtener la consulta de los argumentos de línea de comandos
  const query = process.argv[2];
  
  if (!query) {
    console.error('Por favor proporciona una consulta. Ejemplo: ts-node src/rag/test.ts "¿Cómo obtener una habilitación comercial?"');
    process.exit(1);
  }
  
  console.log(`Buscando información para: "${query}"`);
  
  try {
    // Realizar la consulta
    const results = await queryDocuments(query, 3);
    
    if (results.length === 0) {
      console.log('No se encontraron resultados relevantes.');
      process.exit(0);
    }
    
    // Mostrar los resultados
    console.log(`\nSe encontraron ${results.length} resultados:`);
    
    results.forEach((result, i) => {
      console.log(`\n--- Resultado ${i+1} ---`);
      console.log(`Fuente: ${result.metadata.source}`);
      if (result.metadata.page) console.log(`Página: ${result.metadata.page}`);
      console.log(`Relevancia: ${result.score ? (1 - result.score).toFixed(4) : 'N/A'}`);
      
      // Mostrar el contenido con formato
      console.log(`\nContenido:`);
      console.log('='.repeat(80));
      console.log(result.content);
      console.log('='.repeat(80));
    });
    
    // Mostrar cómo se usarían los resultados en una respuesta
    console.log('\n--- Simulación de respuesta ---');
    console.log(`Para la consulta: "${query}"`);
    console.log('\nLa información recuperada sería usada para generar una respuesta contextualizada.');
    console.log('El modelo de lenguaje combinaría esta información con sus conocimientos generales');
    console.log('para proporcionar una respuesta precisa y específica para el municipio.');
    
  } catch (error) {
    console.error('Error al ejecutar la prueba:', error);
    process.exit(1);
  }
}

// Ejecutar la prueba
testRAG();
