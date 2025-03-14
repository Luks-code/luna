import { PrismaClient } from '@prisma/client';

// Creamos una instancia global del cliente Prisma
declare global {
  var prisma: PrismaClient | undefined;
}

// Evitamos múltiples instancias del cliente Prisma durante desarrollo
export const prisma = global.prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

// Tipos de reclamos disponibles
export const ComplaintTypes = {
  AP: 'Alumbrado Público',
  BL: 'Barrido y Limpieza',
  R: 'Residuos Verdes y Especiales',
  AM: 'Animales Muertos',
  P: 'Poda',
  IG: 'Inspección General',
  T: 'Tránsito',
  SA: 'Saneamiento Ambiental',
  OP: 'Obras Públicas',
  SAT: 'Servicios de Agua y Cloacas',
  REC: 'Recolección de Residuos',
  GUM: 'Guardia Urbana Municipal',
  BRO1: 'Bromatología',
  OTRO: 'Otros'
} as const;

// Funciones helper para la base de datos
export async function findOrCreateCitizen(data: {
  name: string;
  documentId: string;
  phone: string;
  address: string;
}) {
  try {
    // Primero intentamos encontrar por documentId
    let citizen = await prisma.citizen.findUnique({
      where: { documentId: data.documentId }
    });

    if (citizen) {
      // Si existe, actualizamos sus datos
      return await prisma.citizen.update({
        where: { id: citizen.id },
        data: {
          name: data.name,
          phone: data.phone,
          address: data.address
        }
      });
    }

    // Si no existe por documentId, buscamos por teléfono
    citizen = await prisma.citizen.findUnique({
      where: { phone: data.phone }
    });

    if (citizen) {
      // Si existe por teléfono, actualizamos sus datos
      return await prisma.citizen.update({
        where: { id: citizen.id },
        data: {
          name: data.name,
          documentId: data.documentId,
          address: data.address
        }
      });
    }

    // Si no existe, lo creamos
    return await prisma.citizen.create({
      data
    });
  } catch (error) {
    console.error('Error en findOrCreateCitizen:', error);
    throw error;
  }
}

export async function createComplaint(data: {
  type: string;
  description: string;
  location: string;
  citizenId: number;
  notes?: string;
}) {
  return await prisma.complaint.create({
    data: {
      ...data,
      status: 'PENDIENTE'
    },
    include: {
      citizen: true
    }
  });
}
