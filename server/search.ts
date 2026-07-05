import { SQL, and, asc, count, like, or, sql } from 'drizzle-orm';

import type { Db } from './db';
import type { SharedFile } from './schema';
import { sharedFiles } from './schema';

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
  db: Db,
  params: SearchParams & { skipTotal: true },
): Promise<{ files: SharedFile[] }>;
export async function searchFiles(db: Db, params: SearchParams): Promise<SearchResult>;
export async function searchFiles(
  db: Db,
  params: SearchParams,
): Promise<SearchResult | { files: SharedFile[] }> {
  const { type = 'all', limit = 50, offset = 0 } = params;
  const query = params.query.trim();

  const clauses: (SQL | undefined)[] = [];

  if (query) {
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    const q = `%${escaped}%`;
    clauses.push(
      or(
        sql`${sharedFiles.filename} LIKE ${q} ESCAPE '\\'`,
        sql`${sharedFiles.path} LIKE ${q} ESCAPE '\\'`,
        sql`${sharedFiles.metadata} LIKE ${q} ESCAPE '\\'`,
      ),
    );
  }

  const mimeClause = getMimeClause(type);
  if (mimeClause) clauses.push(mimeClause);

  const where = clauses.length > 0 ? and(...clauses) : undefined;

  const baseQuery = db
    .select()
    .from(sharedFiles)
    .orderBy(asc(sharedFiles.filename), asc(sharedFiles.id))
    .limit(limit)
    .offset(offset);

  const files = where ? baseQuery.where(where).all() : baseQuery.all();

  if (params.skipTotal) return { files };

  const countQuery = db.select({ total: count() }).from(sharedFiles);
  const { total } = where ? countQuery.where(where).get()! : countQuery.get()!;

  return { files, total };
}

function getMimeClause(type: FileType): SQL | undefined {
  switch (type) {
    case 'audio':
      return like(sharedFiles.mimeType, 'audio/%');
    case 'video':
      return like(sharedFiles.mimeType, 'video/%');
    case 'image':
      return like(sharedFiles.mimeType, 'image/%');
    case 'document':
      return or(
        like(sharedFiles.mimeType, 'text/%'),
        like(sharedFiles.mimeType, 'application/pdf%'),
        like(sharedFiles.mimeType, 'application/msword%'),
        like(sharedFiles.mimeType, 'application/vnd.openxmlformats%'),
        like(sharedFiles.mimeType, 'application/vnd.oasis%'),
      );
    case 'ebook':
      return or(
        like(sharedFiles.mimeType, 'application/epub%'),
        like(sharedFiles.mimeType, '%mobi%'),
        like(sharedFiles.mimeType, '%ebook%'),
      );
    default:
      return undefined;
  }
}
