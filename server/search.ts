import { Prisma, type PrismaClient, type SharedFile } from '@prisma/client';

export type FileType = 'all' | 'audio' | 'video' | 'image' | 'document' | 'ebook';

export type SearchParams = {
  query: string;
  type?: FileType;
  limit?: number;
  offset?: number;
  skipTotal?: boolean;
};

export type SearchResult = {
  files: SharedFile[];
  total: number;
};

export async function searchFiles(
  prisma: PrismaClient,
  params: SearchParams,
): Promise<SearchResult> {
  const { type = 'all', limit = 50, offset = 0 } = params;
  const query = params.query.trim();

  const conditions: Prisma.SharedFileWhereInput[] = [];

  if (query) {
    // SQLite LIKE '%q%' is case-insensitive for ASCII but prevents index use.
    // For large collections, migrate to SQLite FTS5 via a virtual table.
    conditions.push({
      OR: [
        { filename: { contains: query } },
        { path: { contains: query } },
        { metadata: { contains: query } },
      ],
    });
  }

  const mimeFilter = getMimeFilter(type);
  if (mimeFilter) conditions.push(mimeFilter);

  const where: Prisma.SharedFileWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  const findMany = prisma.sharedFile.findMany({
    where,
    take: limit,
    skip: offset,
    orderBy: [{ filename: 'asc' }, { id: 'asc' }],
  });

  if (params.skipTotal) {
    return { files: await findMany, total: 0 };
  }

  const [files, total] = await Promise.all([findMany, prisma.sharedFile.count({ where })]);
  return { files, total };
}

function getMimeFilter(type: FileType): Prisma.SharedFileWhereInput | null {
  switch (type) {
    case 'audio':
      return { mimeType: { startsWith: 'audio/' } };
    case 'video':
      return { mimeType: { startsWith: 'video/' } };
    case 'image':
      return { mimeType: { startsWith: 'image/' } };
    case 'document':
      return {
        OR: [
          { mimeType: { startsWith: 'text/' } },
          { mimeType: { startsWith: 'application/pdf' } },
          { mimeType: { startsWith: 'application/msword' } },
          { mimeType: { startsWith: 'application/vnd.openxmlformats' } },
          { mimeType: { startsWith: 'application/vnd.oasis' } },
        ],
      };
    case 'ebook':
      return {
        OR: [
          { mimeType: { startsWith: 'application/epub' } },
          { mimeType: { contains: 'mobi' } },
          { mimeType: { contains: 'ebook' } },
        ],
      };
    default:
      return null;
  }
}
