import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

export function createPrismaClient(url?: string): PrismaClient {
  const dbUrl = url ?? process.env.DATABASE_URL ?? 'file:./data/filenet.db';
  const adapter = new PrismaLibSql({ url: dbUrl });
  return new PrismaClient({ adapter });
}
