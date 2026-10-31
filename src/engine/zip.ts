// A small zip writer and reader in pure TypeScript, for the .capstanz project package.
//
// Writer: streams. Each entry is a local header with the "sizes follow" flag, the data (stored,
// or deflate-raw through CompressionStream), then a data descriptor, so a multi-gigabyte media
// file is read in chunks and never held whole in memory. Reader: works from the central
// directory, checks every entry before it hands anything out (safe names, sizes, ratios, local
// header agreement) and verifies CRC-32 and size on the way out, so a damaged or hostile archive
// fails with a clear message instead of producing garbage.
//
// Not supported (and refused with a clear error): zip64 (4 GiB limit), encryption, multi-disk
// archives, compression methods other than store and deflate.

const GIB = 1024 * 1024 * 1024;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

export interface ZipLimits {
  /** Most entries an archive may hold. */
  maxEntries: number;
  /** Largest single entry once unpacked, in bytes. */
  maxEntryBytes: number;
  /** Largest sum of all entries once unpacked, in bytes. */
  maxTotalBytes: number;
  /** A deflated entry may not claim to expand more than this many times (plus 1 MiB of slack). */
  maxRatio: number;
  /** Longest entry name in UTF-8 bytes. */
  maxNameBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 4 * GIB - 1,
  maxTotalBytes: 4 * GIB - 1,
  maxRatio: 200,
  maxNameBytes: 255,
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

// ---------- CRC-32 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (the zip/PNG polynomial). Pass the previous result as `crc` to continue over more data. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- names ----------

/**
 * Returns why an entry name is unsafe, or null when it is fine. Names must be relative, use forward
 * slashes, and contain no `.` or `..` segments, drive letters, control characters or empty segments.
 * (A trailing slash marks a directory entry and is allowed.)
 */
export function unsafeEntryName(name: string, limits: Pick<ZipLimits, 'maxNameBytes'> = DEFAULT_ZIP_LIMITS): string | null {
  if (!name) return 'empty name';
  if (new TextEncoder().encode(name).length > limits.maxNameBytes) return 'name too long';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return 'control character in name';
  if (name.includes('\\')) return 'backslash in name';
  if (name.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'drive letter in path';
  const parts = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
  for (const part of parts) {
    if (part === '') return 'empty path segment';
    if (part === '.' || part === '..') return 'path traversal';
  }
  return null;
}

// ---------- DOS date and time ----------

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// ---------- writer ----------

export interface ZipSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

export interface ZipSource {
  name: string;
  data: Blob | Uint8Array;
  /** `deflate` compresses in memory (use it for small text such as JSON); media should be stored. */
  method?: 'store' | 'deflate';
  modified?: Date;
}

export interface WriteZipOptions {
  limits?: Partial<ZipLimits>;
  onProgress?(doneBytes: number, totalBytes: number, name: string): void;
}

export function canDeflate(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function u16(view: DataView, at: number, v: number) {
  view.setUint16(at, v, true);
}
function u32(view: DataView, at: number, v: number) {
  view.setUint32(at, v >>> 0, true);
}

const CHUNK = 1024 * 1024;

async function* chunksOf(data: Blob | Uint8Array): AsyncGenerator<Uint8Array> {
  if (data instanceof Uint8Array) {
    for (let i = 0; i < data.length; i += CHUNK) yield data.subarray(i, Math.min(data.length, i + CHUNK));
    return;
  }
  const reader = data.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

interface Written {
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/** Writes the entries as a zip archive to `sink`. Resolves with the entry count and bytes written. */
export async function writeZip(sources: ZipSource[], sink: ZipSink, options: WriteZipOptions = {}): Promise<{ entries: number; bytes: number }> {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...options.limits };
  if (sources.length > Math.min(limits.maxEntries, U16_MAX)) throw new ZipError(`Too many files for a package (${sources.length}; the limit is ${Math.min(limits.maxEntries, U16_MAX)}).`);
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let planned = 0;
  for (const s of sources) {
    const why = unsafeEntryName(s.name, limits);
    if (why) throw new ZipError(`Cannot add "${s.name}" to the package: ${why}.`);
    if (s.name.endsWith('/')) throw new ZipError(`Cannot add "${s.name}": directory entries are not written.`);
    const key = s.name.toLowerCase();
    if (seen.has(key)) throw new ZipError(`Two files in the package would have the same name: "${s.name}".`);
    seen.add(key);
    const size = s.data instanceof Uint8Array ? s.data.length : s.data.size;
    if (size > limits.maxEntryBytes) throw new ZipError(`"${s.name}" is too large for a package (4 GiB limit per file).`);
    planned += size;
  }
  // Worst case if nothing compresses, plus headers; zip64 would be needed beyond 4 GiB.
  if (planned + sources.length * 400 > U32_MAX) throw new ZipError('This project is too large for one package (the .capstanz format stops at 4 GiB). Remove or shorten some media and try again.');

  let pos = 0;
  let done = 0;
  const emit = async (chunk: Uint8Array) => {
    await sink.write(chunk);
    pos += chunk.length;
  };
  const written: Written[] = [];

  for (const s of sources) {
    const nameBytes = encoder.encode(s.name);
    const stamp = dosDateTime(s.modified ?? new Date());
    let method = 0;
    let payload: Blob | Uint8Array = s.data;
    let rawCrc = 0;
    let rawSize = 0;
    if (s.method === 'deflate' && canDeflate()) {
      const raw = s.data instanceof Uint8Array ? s.data : new Uint8Array(await s.data.arrayBuffer());
      const packed = await deflateRaw(raw);
      // Only keep it when it actually helps.
      if (packed.length < raw.length) {
        method = 8;
        payload = packed;
        rawCrc = crc32(raw);
        rawSize = raw.length;
      } else payload = raw;
    }
    const flags = 0x0808; // bit 3: sizes in the data descriptor, bit 11: UTF-8 names
    const offset = pos;
    const head = new Uint8Array(30 + nameBytes.length);
    const hv = new DataView(head.buffer);
    u32(hv, 0, 0x04034b50);
    u16(hv, 4, 20);
    u16(hv, 6, flags);
    u16(hv, 8, method);
    u16(hv, 10, stamp.time);
    u16(hv, 12, stamp.date);
    // CRC and sizes are zero here; the descriptor after the data carries them.
    u16(hv, 26, nameBytes.length);
    u16(hv, 28, 0);
    head.set(nameBytes, 30);
    await emit(head);

    let crc = 0;
    let compressed = 0;
    for await (const chunk of chunksOf(payload)) {
      await emit(chunk);
      compressed += chunk.length;
      if (method === 0) crc = crc32(chunk, crc);
      done += chunk.length;
      options.onProgress?.(done, planned, s.name);
    }
    let size = compressed;
    if (method === 8) {
      crc = rawCrc;
      size = rawSize;
    }
    const expected = s.data instanceof Uint8Array ? s.data.length : s.data.size;
    if (method === 0 && size !== expected) throw new ZipError(`"${s.name}" changed while it was being packed. Try again.`);
    if (pos + 16 > U32_MAX) throw new ZipError('This project is too large for one package (the .capstanz format stops at 4 GiB).');

    const desc = new Uint8Array(16);
    const dv = new DataView(desc.buffer);
    u32(dv, 0, 0x08074b50);
    u32(dv, 4, crc);
    u32(dv, 8, compressed);
    u32(dv, 12, size);
    await emit(desc);
    written.push({ nameBytes, flags, method, time: stamp.time, date: stamp.date, crc, compressed, size, offset });
  }

  const cdStart = pos;
  for (const w of written) {
    const rec = new Uint8Array(46 + w.nameBytes.length);
    const v = new DataView(rec.buffer);
    u32(v, 0, 0x02014b50);
    u16(v, 4, 20);
    u16(v, 6, 20);
    u16(v, 8, w.flags);
    u16(v, 10, w.method);
    u16(v, 12, w.time);
    u16(v, 14, w.date);
    u32(v, 16, w.crc);
    u32(v, 20, w.compressed);
    u32(v, 24, w.size);
    u16(v, 28, w.nameBytes.length);
    u32(v, 42, w.offset);
    rec.set(w.nameBytes, 46);
    await emit(rec);
  }
  const cdSize = pos - cdStart;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 8, written.length);
  u16(ev, 10, written.length);
  u32(ev, 12, cdSize);
  u32(ev, 16, cdStart);
  await emit(end);
  return { entries: written.length, bytes: pos };
}

/** Collects the archive in memory-backed Blob parts (the browser may spill big Blobs to disk). */
export class BlobSink implements ZipSink {
  private parts: BlobPart[] = [];
  write(chunk: Uint8Array) {
    // Copy: the writer may hand out views over its own buffers.
    this.parts.push(chunk.slice());
  }
  blob(type = 'application/zip'): Blob {
    return new Blob(this.parts, { type });
  }
}

// ---------- reader ----------

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  crc: number;
  compressedSize: number;
  size: number;
  /** Offset of the local header. */
  offset: number;
}

const decoder = new TextDecoder('utf-8');

async function readBytes(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

export class ZipArchive {
  constructor(
    private readonly source: Blob,
    readonly entries: ZipEntry[],
    private readonly limits: ZipLimits,
  ) {}

  find(name: string): ZipEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  /** The bytes of an entry's data after the local header (checked against the central directory). */
  private async dataSlice(entry: ZipEntry): Promise<Blob> {
    const head = await readBytes(this.source, entry.offset, entry.offset + 30);
    if (head.byteLength < 30 || head.getUint32(0, true) !== 0x04034b50) throw new ZipError(`"${entry.name}" is damaged (bad local header).`);
    const nameLen = head.getUint16(26, true);
    const extraLen = head.getUint16(28, true);
    const nameView = await readBytes(this.source, entry.offset + 30, entry.offset + 30 + nameLen);
    const localName = decoder.decode(new Uint8Array(nameView.buffer));
    if (localName !== entry.name) throw new ZipError(`"${entry.name}" is damaged (its two headers disagree).`);
    const start = entry.offset + 30 + nameLen + extraLen;
    if (start + entry.compressedSize > this.source.size) throw new ZipError(`"${entry.name}" is damaged (the file is cut short).`);
    return this.source.slice(start, start + entry.compressedSize);
  }

  /**
   * Unpacks one entry into a Blob, verifying size and CRC-32. `maxBytes` lowers the cap for entries
   * that are read into memory (JSON). Stored entries are returned as a slice of the archive.
   */
  async blob(entry: ZipEntry, options: { maxBytes?: number; type?: string } = {}): Promise<Blob> {
    const cap = Math.min(options.maxBytes ?? Infinity, this.limits.maxEntryBytes);
    if (entry.size > cap) throw new ZipError(`"${entry.name}" is larger than allowed (${entry.size} bytes).`);
    const slice = await this.dataSlice(entry);
    if (entry.method === 0) {
      let crc = 0;
      let count = 0;
      for await (const chunk of chunksOf(slice)) {
        crc = crc32(chunk, crc);
        count += chunk.length;
      }
      if (count !== entry.size || crc !== entry.crc) throw new ZipError(`"${entry.name}" is corrupt (checksum does not match).`);
      return slice.slice(0, slice.size, options.type ?? '');
    }
    if (typeof DecompressionStream === 'undefined') throw new ZipError(`"${entry.name}" is compressed and this browser cannot unpack it.`);
    const parts: Uint8Array[] = [];
    let crc = 0;
    let count = 0;
    try {
      const reader = slice.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.length;
        // The declared size is what the central directory promised; refuse anything past it.
        if (count > entry.size) {
          await reader.cancel().catch(() => undefined);
          throw new ZipError(`"${entry.name}" expands beyond its declared size; the package is damaged or unsafe.`);
        }
        crc = crc32(value, crc);
        parts.push(value);
      }
    } catch (e) {
      if (e instanceof ZipError) throw e;
      throw new ZipError(`"${entry.name}" is corrupt (it could not be unpacked).`);
    }
    if (count !== entry.size || crc !== entry.crc) throw new ZipError(`"${entry.name}" is corrupt (checksum does not match).`);
    return new Blob(parts as BlobPart[], { type: options.type ?? '' });
  }

  async bytes(entry: ZipEntry, maxBytes = 64 * 1024 * 1024): Promise<Uint8Array> {
    return new Uint8Array(await (await this.blob(entry, { maxBytes })).arrayBuffer());
  }

  async text(entry: ZipEntry, maxBytes = 64 * 1024 * 1024): Promise<string> {
    return decoder.decode(await this.bytes(entry, maxBytes));
  }
}

/** Reads the central directory of `source` and validates every entry. Throws ZipError with a plain message. */
export async function openZip(source: Blob, limitOverrides: Partial<ZipLimits> = {}): Promise<ZipArchive> {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...limitOverrides };
  if (source.size < 22) throw new ZipError('This is not a zip archive (too small).');
  const tailStart = Math.max(0, source.size - (22 + U16_MAX));
  const tail = await readBytes(source, tailStart, source.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50 && i + 22 + tail.getUint16(i + 20, true) === tail.byteLength) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('This is not a zip archive (no end-of-archive record). The file may be cut short.');
  const disk = tail.getUint16(eocd + 4, true);
  const cdDisk = tail.getUint16(eocd + 6, true);
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('Multi-part archives are not supported.');
  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) throw new ZipError('Zip64 archives (over 4 GiB) are not supported.');
  if (count > limits.maxEntries) throw new ZipError(`The archive holds too many files (${count}).`);
  if (cdSize > 32 * 1024 * 1024 || cdOffset + cdSize > source.size) throw new ZipError('The archive directory is damaged.');

  const cd = await readBytes(source, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > cd.byteLength || cd.getUint32(at, true) !== 0x02014b50) throw new ZipError('The archive directory is damaged.');
    const flags = cd.getUint16(at + 8, true);
    const method = cd.getUint16(at + 10, true);
    const crc = cd.getUint32(at + 16, true);
    const compressedSize = cd.getUint32(at + 20, true);
    const size = cd.getUint32(at + 24, true);
    const nameLen = cd.getUint16(at + 28, true);
    const extraLen = cd.getUint16(at + 30, true);
    const commentLen = cd.getUint16(at + 32, true);
    const offset = cd.getUint32(at + 42, true);
    if (at + 46 + nameLen + extraLen + commentLen > cd.byteLength) throw new ZipError('The archive directory is damaged.');
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + at + 46, nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    const why = unsafeEntryName(name, limits);
    if (why) throw new ZipError(`The package contains an unsafe file name ("${name.slice(0, 80)}": ${why}). It was not opened.`);
    if (name.endsWith('/')) continue; // directory entry: nothing to read
    if (flags & 1) throw new ZipError(`"${name}" is encrypted; encrypted archives are not supported.`);
    if (method !== 0 && method !== 8) throw new ZipError(`"${name}" uses an unsupported compression method (${method}).`);
    if (compressedSize === U32_MAX || size === U32_MAX || offset === U32_MAX) throw new ZipError('Zip64 archives (over 4 GiB) are not supported.');
    if (size > limits.maxEntryBytes) throw new ZipError(`"${name}" is larger than allowed.`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError('The archive unpacks to more than the allowed total size.');
    if (method === 0 && compressedSize !== size) throw new ZipError(`"${name}" is damaged (stored size mismatch).`);
    if (method === 8 && size > compressedSize * limits.maxRatio + 1024 * 1024) throw new ZipError(`"${name}" expands far more than a real file would; the archive looks like a zip bomb and was not opened.`);
    if (offset + 30 + compressedSize > cdOffset) throw new ZipError(`"${name}" is damaged (it points outside the archive).`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipError(`The package lists "${name}" twice.`);
    seen.add(key);
    entries.push({ name, method: method as 0 | 8, crc, compressedSize, size, offset });
  }
  return new ZipArchive(source, entries, limits);
}
