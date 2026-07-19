import type { LocalFile, NetworkFile } from './api';

export type SearchHit = {
  sha256: string;
  filename: string;
  size: string;
  mimeType: string | null;
  metadata: string | null;
  local: boolean;
  networkSources: NetworkFile[];
};

export type ParsedMeta = {
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string;
  track?: string;
  duration?: number;
  bitrate?: number;
  genre?: string;
  width?: number;
  height?: number;
  pageCount?: number;
};

export function mergeResults(local: LocalFile[], network: NetworkFile[]): SearchHit[] {
  const map = new Map<string, SearchHit>();
  for (const f of local) {
    map.set(f.sha256, {
      sha256: f.sha256,
      filename: f.filename,
      size: f.size,
      mimeType: f.mimeType,
      metadata: f.metadata,
      local: true,
      networkSources: [],
    });
  }
  for (const n of network) {
    const existing = map.get(n.sha256);
    if (existing) {
      existing.networkSources.push(n);
    } else {
      map.set(n.sha256, {
        sha256: n.sha256,
        filename: n.filename,
        size: n.size,
        mimeType: n.mimeType,
        metadata: n.metadata,
        local: false,
        networkSources: [n],
      });
    }
  }
  return Array.from(map.values());
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function parseMeta(raw: string | null): ParsedMeta | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ParsedMeta;
  } catch {
    return null;
  }
}

export function mimeIcon(mimeType: string | null): string {
  if (!mimeType) return '📄';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('image/')) return '🖼';
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('epub') || mimeType.includes('ebook')) return '📚';
  if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
  return '📄';
}

export function sourceCount(hit: SearchHit): number {
  return (hit.local ? 1 : 0) + hit.networkSources.length;
}

// Relayed results carry the producer's nodeId but we only have a WebSocket
// to whoever forwarded it (viaNodeId), so only count/allow sources we can
// actually download from directly.
export function directSources(hit: SearchHit): NetworkFile[] {
  return hit.networkSources.filter((n) => !n.viaNodeId || n.viaNodeId === n.nodeId);
}

export type SortColumn = 'name' | 'type' | 'size' | 'sources';
export type SortDirection = 'asc' | 'desc';

export const DEFAULT_SORT: { column: SortColumn; direction: SortDirection } = {
  column: 'sources',
  direction: 'desc',
};

export function defaultDirectionFor(column: SortColumn): SortDirection {
  return column === 'name' || column === 'type' ? 'asc' : 'desc';
}

function typeLabel(hit: SearchHit): string {
  if (!hit.mimeType) return '';
  return hit.mimeType.split('/')[1] ?? hit.mimeType;
}

function compareBigIntStrings(a: string, b: string): number {
  let an: bigint;
  let bn: bigint;
  try {
    an = BigInt(a);
  } catch {
    an = 0n;
  }
  try {
    bn = BigInt(b);
  } catch {
    bn = 0n;
  }
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

function compareByColumn(column: SortColumn, a: SearchHit, b: SearchHit): number {
  switch (column) {
    case 'name':
      return a.filename.localeCompare(b.filename, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    case 'type':
      return typeLabel(a).localeCompare(typeLabel(b), undefined, { sensitivity: 'base' });
    case 'size':
      return compareBigIntStrings(a.size, b.size);
    case 'sources':
      return sourceCount(a) - sourceCount(b);
  }
}

export function sortHits(
  hits: SearchHit[],
  column: SortColumn,
  direction: SortDirection,
): SearchHit[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...hits].sort((a, b) => sign * compareByColumn(column, a, b));
}

export function detailColumnValue(hit: SearchHit): string {
  const meta = parseMeta(hit.metadata);
  if (!meta) return '—';
  const mime = hit.mimeType ?? '';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    if (typeof meta.duration === 'number') return formatDuration(meta.duration);
  } else if (mime.startsWith('image/')) {
    if (meta.width && meta.height) return `${meta.width}×${meta.height}`;
  } else if (mime.includes('pdf')) {
    if (typeof meta.pageCount === 'number')
      return `${meta.pageCount} ${meta.pageCount === 1 ? 'page' : 'pages'}`;
  }
  return '—';
}
