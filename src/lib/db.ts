import { PrismaClient, type Prisma } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// Type exports for transaction-aware outbox emission.
export type ExtendedPrismaClient = typeof db
export type ExtendedTransactionClient = Prisma.TransactionClient
