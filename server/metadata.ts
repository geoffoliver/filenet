import { extname } from 'node:path';

import { parseFile } from 'music-metadata';

const MAX_DOC_BYTES = 50_000_000; // 50 MB — guard against OOM on huge files
const MAX_TEXT_FIELD = 500; // keep metadata JSON safely under the 4096-char protocol limit

function clampStrings(meta: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(meta)) {
    if (typeof meta[k] === 'string' && (meta[k] as string).length > MAX_TEXT_FIELD)
      meta[k] = (meta[k] as string).slice(0, MAX_TEXT_FIELD);
  }
  return meta;
}

const AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aif',
  '.aiff',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
]);

const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm', '.wmv']);

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.heic',
  '.jpg',
  '.jpeg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
]);

export async function extractMetadata(path: string): Promise<Record<string, unknown> | null> {
  const ext = extname(path).toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) return extractAudioMetadata(path);
  if (VIDEO_EXTENSIONS.has(ext)) return extractVideoMetadata(path);
  if (IMAGE_EXTENSIONS.has(ext)) return extractImageMetadata(path);
  if (ext === '.pdf') return extractPdfMetadata(path);
  if (ext === '.epub') return extractEpubMetadata(path);
  if (ext === '.docx') return extractDocxMetadata(path);
  return null;
}

async function extractAudioMetadata(path: string): Promise<Record<string, unknown> | null> {
  try {
    const { common, format } = await parseFile(path);
    const meta: Record<string, unknown> = {};
    if (common.title) meta.title = common.title;
    if (common.artist) meta.artist = common.artist;
    if (common.album) meta.album = common.album;
    if (common.albumartist) meta.albumArtist = common.albumartist;
    if (common.year) meta.year = common.year;
    if (common.track?.no != null) meta.trackNumber = common.track.no;
    if (common.track?.of != null) meta.trackTotal = common.track.of;
    if (common.disk?.no != null) meta.discNumber = common.disk.no;
    if (common.genre?.[0]) meta.genre = common.genre[0];
    if (format.duration != null) meta.duration = format.duration;
    if (format.bitrate) meta.bitrate = Math.round(format.bitrate / 1000);
    if (format.sampleRate) meta.sampleRate = format.sampleRate;
    if (format.numberOfChannels) meta.channels = format.numberOfChannels;
    return Object.keys(meta).length > 0 ? clampStrings(meta) : null;
  } catch {
    return null;
  }
}

async function extractVideoMetadata(path: string): Promise<Record<string, unknown> | null> {
  try {
    const { common, format } = await parseFile(path);
    const meta: Record<string, unknown> = {};
    if (common.title) meta.title = common.title;
    if (format.duration != null) meta.duration = format.duration;
    if (format.bitrate) meta.bitrate = Math.round(format.bitrate / 1000);
    if (format.container) meta.container = format.container;
    const videoTrack = format.trackInfo?.find((t) => t.video !== undefined);
    if (videoTrack?.video?.pixelWidth != null) meta.width = videoTrack.video.pixelWidth;
    if (videoTrack?.video?.pixelHeight != null) meta.height = videoTrack.video.pixelHeight;
    if (videoTrack?.codecName) meta.codec = videoTrack.codecName;
    return Object.keys(meta).length > 0 ? clampStrings(meta) : null;
  } catch {
    return null;
  }
}

async function extractImageMetadata(path: string): Promise<Record<string, unknown> | null> {
  try {
    const exifr = await import('exifr');
    const exif = (await exifr.parse(path, { gps: false })) as Record<string, unknown> | undefined;
    if (!exif || Object.keys(exif).length === 0) return null;
    const meta: Record<string, unknown> = {};
    const width = (exif.ExifImageWidth ?? exif.ImageWidth) as number | undefined;
    const height = (exif.ExifImageHeight ?? exif.ImageHeight) as number | undefined;
    if (width != null) meta.width = width;
    if (height != null) meta.height = height;
    if (exif.Make) meta.make = exif.Make;
    if (exif.Model) meta.model = exif.Model;
    const dt = exif.DateTimeOriginal ?? exif.DateTime;
    if (dt != null) meta.dateTime = dt instanceof Date ? dt.toISOString() : String(dt);
    return Object.keys(meta).length > 0 ? clampStrings(meta) : null;
  } catch {
    return null;
  }
}

async function extractPdfMetadata(path: string): Promise<Record<string, unknown> | null> {
  let destroy: (() => Promise<void>) | null = null;
  try {
    const { PDFParse } = await import('pdf-parse');
    const file = Bun.file(path);
    if (file.size > MAX_DOC_BYTES) return null;
    const data = await file.arrayBuffer();
    const parser = new PDFParse({ data: new Uint8Array(data) });
    destroy = () => parser.destroy();
    const result = await parser.getInfo();
    const meta: Record<string, unknown> = {};
    if (result.info?.Title) meta.title = result.info.Title;
    if (result.info?.Author) meta.author = result.info.Author;
    if (result.info?.Subject) meta.subject = result.info.Subject;
    if (result.info?.Keywords) meta.keywords = String(result.info.Keywords);
    if (result.total > 0) meta.pageCount = result.total;
    return Object.keys(meta).length > 0 ? clampStrings(meta) : null;
  } catch {
    return null;
  } finally {
    await destroy?.().catch(() => {});
  }
}

async function extractEpubMetadata(path: string): Promise<Record<string, unknown> | null> {
  try {
    const JSZip = (await import('jszip')).default;
    const file = Bun.file(path);
    if (file.size > MAX_DOC_BYTES) return null;
    const data = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(data);

    const containerXml = await zip.file('META-INF/container.xml')?.async('text');
    if (!containerXml) return null;

    const opfPath = containerXml.match(/full-path="([^"]+\.opf)"/)?.[1];
    if (!opfPath) return null;

    const opfXml = await zip.file(opfPath)?.async('text');
    if (!opfXml) return null;

    const extractTag = (xml: string, tag: string): string | null => {
      const m = xml.match(new RegExp(`<dc:${tag}[^>]*>([^<]+)<`, 'i'));
      return m ? m[1].trim() : null;
    };

    const meta: Record<string, unknown> = {};
    const title = extractTag(opfXml, 'title');
    const creator = extractTag(opfXml, 'creator');
    const language = extractTag(opfXml, 'language');
    const publisher = extractTag(opfXml, 'publisher');
    const description = extractTag(opfXml, 'description');
    const identifier = extractTag(opfXml, 'identifier');
    const date = extractTag(opfXml, 'date');
    if (title) meta.title = title;
    if (creator) meta.author = creator;
    if (language) meta.language = language;
    if (publisher) meta.publisher = publisher;
    if (description) meta.description = description;
    if (identifier) meta.identifier = identifier;
    if (date) meta.published = date;
    return Object.keys(meta).length > 0 ? clampStrings(meta) : null;
  } catch {
    return null;
  }
}

async function extractDocxMetadata(path: string): Promise<Record<string, unknown> | null> {
  try {
    const JSZip = (await import('jszip')).default;
    const file = Bun.file(path);
    if (file.size > MAX_DOC_BYTES) return null;
    const data = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(data);

    const coreXml = await zip.file('docProps/core.xml')?.async('text');
    if (!coreXml) return null;

    const extractTag = (xml: string, tag: string): string | null => {
      const m = xml.match(new RegExp(`<(?:dc:|cp:|dcterms:)?${tag}[^>]*>([^<]+)<`, 'i'));
      return m ? m[1].trim() : null;
    };

    const meta: Record<string, unknown> = {};
    const title = extractTag(coreXml, 'title');
    const creator = extractTag(coreXml, 'creator');
    const description = extractTag(coreXml, 'description');
    const keywords = extractTag(coreXml, 'keywords');
    const revision = extractTag(coreXml, 'revision');
    if (title) meta.title = title;
    if (creator) meta.author = creator;
    if (description) meta.description = description;
    if (keywords) meta.keywords = keywords;
    if (revision) meta.revision = Number.isInteger(Number(revision)) ? Number(revision) : revision;
    return Object.keys(meta).length > 0 ? clampStrings(meta) : null;
  } catch {
    return null;
  }
}
