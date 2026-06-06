import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { extractMetadata } from '../metadata';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-metadata-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test fixture builders
// ---------------------------------------------------------------------------

function buildMinimalPdf(info: Record<string, string> = {}): Buffer {
  const parts: string[] = [];
  const objOffsets: Record<number, number> = {};
  let pos = 0;

  const add = (s: string): void => {
    parts.push(s);
    pos += s.length; // safe: all characters are ASCII (1 byte each)
  };

  add('%PDF-1.4\n');

  objOffsets[1] = pos;
  add('1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n');

  objOffsets[2] = pos;
  add('2 0 obj\n<</Type /Pages /Count 1 /Kids [3 0 R]>>\nendobj\n');

  objOffsets[3] = pos;
  add('3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>>\nendobj\n');

  const infoEntries = Object.entries(info);
  let trailerInfoRef = '';
  if (infoEntries.length > 0) {
    objOffsets[4] = pos;
    const dict = infoEntries.map(([k, v]) => `/${k} (${v})`).join(' ');
    add(`4 0 obj\n<<${dict}>>\nendobj\n`);
    trailerInfoRef = ' /Info 4 0 R';
  }

  const numObjs = infoEntries.length > 0 ? 5 : 4;
  const xrefOffset = pos;
  add(`xref\n0 ${numObjs}\n`);
  add('0000000000 65535 f \n');
  for (let i = 1; i < numObjs; i++) {
    add(`${String(objOffsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  add(
    `trailer\n<</Size ${numObjs} /Root 1 0 R${trailerInfoRef}>>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.from(parts.join(''));
}

async function buildEpub(meta: {
  title?: string;
  creator?: string;
  language?: string;
  publisher?: string;
  description?: string;
  identifier?: string;
  date?: string;
}): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  zip.file(
    'META-INF/container.xml',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
      '  <rootfiles>',
      '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
      '  </rootfiles>',
      '</container>',
    ].join('\n'),
  );

  const dcTags: string[] = [];
  if (meta.title) dcTags.push(`    <dc:title>${meta.title}</dc:title>`);
  if (meta.creator) dcTags.push(`    <dc:creator>${meta.creator}</dc:creator>`);
  if (meta.language) dcTags.push(`    <dc:language>${meta.language}</dc:language>`);
  if (meta.publisher) dcTags.push(`    <dc:publisher>${meta.publisher}</dc:publisher>`);
  if (meta.description) dcTags.push(`    <dc:description>${meta.description}</dc:description>`);
  if (meta.identifier) dcTags.push(`    <dc:identifier>${meta.identifier}</dc:identifier>`);
  if (meta.date) dcTags.push(`    <dc:date>${meta.date}</dc:date>`);

  zip.file(
    'OEBPS/content.opf',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0">',
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
      ...dcTags,
      '  </metadata>',
      '  <manifest></manifest>',
      '  <spine></spine>',
      '</package>',
    ].join('\n'),
  );

  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

async function buildDocx(meta: {
  title?: string;
  creator?: string;
  description?: string;
  keywords?: string;
  revision?: string;
}): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
  );

  const coreTags: string[] = [];
  if (meta.title) coreTags.push(`  <dc:title>${meta.title}</dc:title>`);
  if (meta.creator) coreTags.push(`  <dc:creator>${meta.creator}</dc:creator>`);
  if (meta.description) coreTags.push(`  <dc:description>${meta.description}</dc:description>`);
  if (meta.keywords) coreTags.push(`  <cp:keywords>${meta.keywords}</cp:keywords>`);
  if (meta.revision) coreTags.push(`  <cp:revision>${meta.revision}</cp:revision>`);

  zip.file(
    'docProps/core.xml',
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"',
      '  xmlns:dc="http://purl.org/dc/elements/1.1/"',
      '  xmlns:dcterms="http://purl.org/dc/terms/">',
      ...coreTags,
      '</cp:coreProperties>',
    ].join('\n'),
  );

  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

// ---------------------------------------------------------------------------
// extractMetadata
// ---------------------------------------------------------------------------

describe('extractMetadata', () => {
  describe('extension routing', () => {
    it('returns null for an unsupported extension', async () => {
      const path = join(tmpDir, 'file.xyz');
      await writeFile(path, 'data');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for a plain text file', async () => {
      const path = join(tmpDir, 'file.txt');
      await writeFile(path, 'hello world');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for an unknown extension', async () => {
      const path = join(tmpDir, 'meta-unknown.abc');
      await writeFile(path, 'data');
      expect(await extractMetadata(path)).toBeNull();
    });
  });

  // ── Audio ──────────────────────────────────────────────────────────────────

  describe('audio', () => {
    it('returns null for an .mp3 with invalid content', async () => {
      const path = join(tmpDir, 'bad.mp3');
      await writeFile(path, 'not real audio data');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for a .flac with invalid content', async () => {
      const path = join(tmpDir, 'bad.flac');
      await writeFile(path, 'not real flac');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for a .wav with invalid content', async () => {
      const path = join(tmpDir, 'bad.wav');
      await writeFile(path, 'not real wav');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('extracts metadata from a valid MP3', async () => {
      // fixtures/sample.mp3: Nick Drake — Introduction, Bryter Layter, 1970
      const meta = await extractMetadata(resolve(__dirname, 'fixtures/sample.mp3'));
      expect(meta).not.toBeNull();
      expect(meta!.title).toBe('Introduction');
      expect(meta!.artist).toBe('Nick Drake');
      expect(meta!.album).toBe('Bryter Layter');
      expect(meta!.year).toBe(1970);
      expect(meta!.genre).toBe('Folk');
      expect(meta!.trackNumber).toBe(1);
      expect(meta!.sampleRate).toBe(44100);
      expect(meta!.channels).toBe(2);
      expect(meta!.bitrate).toBe(128);
      expect(typeof meta!.duration).toBe('number');
    });
  });

  // ── Video ──────────────────────────────────────────────────────────────────

  describe('video', () => {
    it('returns null for an .mp4 with invalid content', async () => {
      const path = join(tmpDir, 'bad.mp4');
      await writeFile(path, 'not real video');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for an .mkv with invalid content', async () => {
      const path = join(tmpDir, 'bad.mkv');
      await writeFile(path, 'not real mkv');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for a .mov with invalid content', async () => {
      const path = join(tmpDir, 'bad.mov');
      await writeFile(path, 'not real mov');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('extracts video dimensions, container, and codec from a valid MKV', async () => {
      // fixtures/sample.mkv: 1-second H.264 clip, 320×240
      const meta = await extractMetadata(resolve(__dirname, 'fixtures/sample.mkv'));
      expect(meta).not.toBeNull();
      expect(meta!.width).toBe(320);
      expect(meta!.height).toBe(240);
      expect(meta!.container).toBe('EBML/matroska');
      expect(meta!.codec).toBe('MPEG4/ISO/AVC');
    });
  });

  // ── Images ─────────────────────────────────────────────────────────────────

  describe('images', () => {
    it('returns null for a .jpg with invalid content', async () => {
      const path = join(tmpDir, 'bad.jpg');
      await writeFile(path, 'not real jpeg');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for a .png with invalid content', async () => {
      const path = join(tmpDir, 'bad.png');
      await writeFile(path, 'not real png');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for a .webp with invalid content', async () => {
      const path = join(tmpDir, 'bad.webp');
      await writeFile(path, 'not real webp');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('extracts EXIF metadata from a JPEG with embedded EXIF', async () => {
      // fixtures/sample.jpg: minimal JPEG with Make=TestCam, Model=TestModel X,
      // DateTimeOriginal=2023:01:15 12:00:00, width=100, height=75
      const meta = await extractMetadata(resolve(__dirname, 'fixtures/sample.jpg'));
      expect(meta).not.toBeNull();
      expect(meta!.make).toBe('TestCam');
      expect(meta!.model).toBe('TestModel X');
      expect(meta!.width).toBe(100);
      expect(meta!.height).toBe(75);
      expect(typeof meta!.dateTime).toBe('string');
      expect(meta!.dateTime as string).toContain('2023');
    });
  });

  // ── PDF ────────────────────────────────────────────────────────────────────

  describe('PDF', () => {
    it('returns null for invalid PDF content', async () => {
      const path = join(tmpDir, 'bad.pdf');
      await writeFile(path, 'not a real pdf');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('extracts metadata from a valid PDF', async () => {
      const path = join(tmpDir, 'valid.pdf');
      await writeFile(
        path,
        buildMinimalPdf({
          Title: 'Test Title',
          Author: 'Test Author',
          Subject: 'Test Subject',
          Keywords: 'test keyword',
        }),
      );
      const meta = await extractMetadata(path);
      expect(meta).not.toBeNull();
      expect(meta!.title).toBe('Test Title');
      expect(meta!.author).toBe('Test Author');
      expect(meta!.subject).toBe('Test Subject');
      expect(meta!.keywords).toBe('test keyword');
      expect(meta!.pageCount).toBe(1);
    });

    it('returns only pageCount for a valid PDF with no Info dictionary', async () => {
      const path = join(tmpDir, 'no-info.pdf');
      await writeFile(path, buildMinimalPdf({}));
      const meta = await extractMetadata(path);
      expect(meta).not.toBeNull();
      expect(meta!.pageCount).toBe(1);
      expect(meta!.title).toBeUndefined();
    });
  });

  // ── EPUB ───────────────────────────────────────────────────────────────────

  describe('EPUB', () => {
    it('returns null for invalid EPUB content', async () => {
      const path = join(tmpDir, 'bad.epub');
      await writeFile(path, 'not a zip file');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for a ZIP missing META-INF/container.xml', async () => {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      zip.file('some-file.txt', 'not an epub');
      const path = join(tmpDir, 'no-container.epub');
      await writeFile(path, (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer);
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for a ZIP with no OPF path in container.xml', async () => {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      zip.file('META-INF/container.xml', '<?xml version="1.0"?><container></container>');
      const path = join(tmpDir, 'no-opf-path.epub');
      await writeFile(path, (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer);
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for an EPUB with empty metadata', async () => {
      const path = join(tmpDir, 'empty-meta.epub');
      await writeFile(path, await buildEpub({}));
      expect(await extractMetadata(path)).toBeNull();
    });

    it('extracts all metadata fields from a valid EPUB', async () => {
      const path = join(tmpDir, 'valid.epub');
      await writeFile(
        path,
        await buildEpub({
          title: 'My Book',
          creator: 'Jane Doe',
          language: 'en',
          publisher: 'Test Publisher',
          description: 'A test book',
          identifier: 'isbn:1234567890',
          date: '2023-01-01',
        }),
      );
      const meta = await extractMetadata(path);
      expect(meta).not.toBeNull();
      expect(meta!.title).toBe('My Book');
      expect(meta!.author).toBe('Jane Doe');
      expect(meta!.language).toBe('en');
      expect(meta!.publisher).toBe('Test Publisher');
      expect(meta!.description).toBe('A test book');
      expect(meta!.identifier).toBe('isbn:1234567890');
      expect(meta!.published).toBe('2023-01-01');
    });

    it('extracts partial metadata when only some fields are present', async () => {
      const path = join(tmpDir, 'partial-epub.epub');
      await writeFile(path, await buildEpub({ title: 'Partial Book', language: 'fr' }));
      const meta = await extractMetadata(path);
      expect(meta).not.toBeNull();
      expect(meta!.title).toBe('Partial Book');
      expect(meta!.language).toBe('fr');
      expect(meta!.author).toBeUndefined();
    });
  });

  // ── DOCX ───────────────────────────────────────────────────────────────────

  describe('DOCX', () => {
    it('returns null for invalid DOCX content', async () => {
      const path = join(tmpDir, 'bad.docx');
      await writeFile(path, 'not a zip file');
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for a ZIP missing docProps/core.xml', async () => {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types></Types>');
      const path = join(tmpDir, 'no-core.docx');
      await writeFile(path, (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer);
      expect(await extractMetadata(path)).toBeNull();
    });

    it('returns null for a DOCX with empty metadata', async () => {
      const path = join(tmpDir, 'empty-docx.docx');
      await writeFile(path, await buildDocx({}));
      expect(await extractMetadata(path)).toBeNull();
    });

    it('extracts all metadata fields from a valid DOCX', async () => {
      const path = join(tmpDir, 'valid.docx');
      await writeFile(
        path,
        await buildDocx({
          title: 'My Document',
          creator: 'John Doe',
          description: 'A test document',
          keywords: 'test docx document',
          revision: '3',
        }),
      );
      const meta = await extractMetadata(path);
      expect(meta).not.toBeNull();
      expect(meta!.title).toBe('My Document');
      expect(meta!.author).toBe('John Doe');
      expect(meta!.description).toBe('A test document');
      expect(meta!.keywords).toBe('test docx document');
      expect(meta!.revision).toBe(3);
    });

    it('extracts partial metadata when only some fields are present', async () => {
      const path = join(tmpDir, 'partial-docx.docx');
      await writeFile(path, await buildDocx({ title: 'Partial Doc', revision: '5' }));
      const meta = await extractMetadata(path);
      expect(meta).not.toBeNull();
      expect(meta!.title).toBe('Partial Doc');
      expect(meta!.revision).toBe(5);
      expect(meta!.author).toBeUndefined();
    });
  });
});
