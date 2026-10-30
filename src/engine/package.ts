// The .capstanz project package: a zip holding everything a project needs, so it can be moved to
// another computer, another browser or another port and open exactly as it was.
//
//   manifest.json            format name and version, app version, project id/name, media list
//   project.json             the project (opened through parseProject, like any project file)
//   media/<id>-<name>        every media Blob, stored as it was imported
//
// Opening is all-or-nothing: every entry the project needs is read and checksum-verified before
// anything is returned, so a damaged package never leaves half a project behind.
import { type Project, parseProject } from './project';
import { type ZipLimits, type ZipSink, type ZipSource, ZipError, openZip, writeZip } from './zip';

export const PACKAGE_EXT = '.capstanz';
export const PACKAGE_FORMAT = 'capstanz';
export const PACKAGE_VERSION = 1;
/** project.json and manifest.json are read into memory; media is never. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

export class PackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageError';
  }
}

export interface PackageManifestMedia {
  id: string;
  path: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  formatVersion: number;
  app: 'Capstan';
  appVersion: string;
  createdAt: number;
  project: { id: string; name: string };
  media: PackageManifestMedia[];
}

function safePart(text: string, max: number): string {
  const cleaned = text
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/^[. ]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'media').slice(0, max);
}

/** `media/<id>-<safe name>`: ids keep two media with the same name apart, the name keeps it readable. */
export function mediaEntryName(id: string, name: string): string {
  return `media/${safePart(id, 48)}-${safePart(name, 80)}`;
}

export interface WritePackageOptions {
  appVersion?: string;
  onProgress?(doneBytes: number, totalBytes: number, name: string): void;
  limits?: Partial<ZipLimits>;
}

/**
 * Writes `project` and all of its media to `sink`. Every media Blob must be available; if any are
 * missing nothing is written and the error names them, because a package that silently lacks
 * media would only fail later, on another computer.
 */
export async function writePackage(
  project: Project,
  getBlob: (mediaId: string) => Promise<Blob | null>,
  sink: ZipSink,
  options: WritePackageOptions = {},
): Promise<{ entries: number; bytes: number }> {
  const blobs = new Map<string, Blob>();
  const missing: string[] = [];
  for (const m of project.media) {
    const blob = await getBlob(m.id);
    if (blob) blobs.set(m.id, blob);
    else missing.push(m.name);
  }
  if (missing.length) {
    throw new PackageError(
      `Cannot save the package: the media for ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` and ${missing.length - 4} more` : ''} is no longer stored in this browser. Remove it from the project or import it again.`,
    );
  }
  const used = new Set<string>();
  const media: PackageManifestMedia[] = project.media.map((m) => {
    let path = mediaEntryName(m.id, m.name);
    // Distinct ids give distinct paths, but two ids can collapse to the same safe form; keep them unique.
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `${mediaEntryName(m.id, m.name)}~${n}`;
    used.add(path.toLowerCase());
    const blob = blobs.get(m.id) as Blob;
    return { id: m.id, path, name: m.name, mime: m.mime, bytes: blob.size };
  });
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_VERSION,
    app: 'Capstan',
    appVersion: options.appVersion ?? '',
    createdAt: Date.now(),
    project: { id: project.id, name: project.name },
    media,
  };
  const encoder = new TextEncoder();
  const sources: ZipSource[] = [
    { name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)), method: 'deflate' },
    { name: 'project.json', data: encoder.encode(JSON.stringify(project)), method: 'deflate' },
    ...media.map((m): ZipSource => ({ name: m.path, data: blobs.get(m.id) as Blob, method: 'store' })),
  ];
  try {
    return await writeZip(sources, sink, { limits: options.limits, onProgress: options.onProgress });
  } catch (e) {
    if (e instanceof ZipError) throw new PackageError(e.message);
    throw e;
  }
}

export interface OpenedPackage {
  project: Project;
  manifest: PackageManifest;
  /** The verified media Blobs by media id. */
  blobs: Map<string, Blob>;
}

function parseManifest(text: string): PackageManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PackageError('manifest.json is not valid JSON; the package is damaged.');
  }
  const m = raw as Partial<PackageManifest> | null;
  if (!m || m.format !== PACKAGE_FORMAT) throw new PackageError('This is a zip file, but not a Capstan package (manifest.json is missing its format).');
  if (typeof m.formatVersion !== 'number' || m.formatVersion > PACKAGE_VERSION) {
    throw new PackageError('This package was made by a newer Capstan. Update Capstan to open it.');
  }
  if (!Array.isArray(m.media)) throw new PackageError('manifest.json has no media list; the package is damaged.');
  const media: PackageManifestMedia[] = [];
  for (const e of m.media) {
    if (!e || typeof e.id !== 'string' || typeof e.path !== 'string') throw new PackageError('manifest.json lists a media file without an id or path; the package is damaged.');
    media.push({ id: e.id, path: e.path, name: String(e.name ?? e.id), mime: String(e.mime ?? ''), bytes: typeof e.bytes === 'number' ? e.bytes : -1 });
  }
  return {
    format: PACKAGE_FORMAT,
    formatVersion: m.formatVersion,
    app: 'Capstan',
    appVersion: String(m.appVersion ?? ''),
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
    project: { id: String(m.project?.id ?? ''), name: String(m.project?.name ?? '') },
    media,
  };
}

/**
 * Reads and fully verifies a package. Throws PackageError with a message fit to show the user for:
 * not a zip, not a Capstan package, unsafe names, project.json that does not parse, media the
 * project needs that is missing, and media that fails its checksum.
 */
export async function readPackage(file: Blob, limits: Partial<ZipLimits> = {}): Promise<OpenedPackage> {
  let zip;
  try {
    zip = await openZip(file, limits);
  } catch (e) {
    if (e instanceof ZipError) throw new PackageError(e.message);
    throw e;
  }
  const manifestEntry = zip.find('manifest.json');
  if (!manifestEntry) throw new PackageError('This is a zip file, but not a Capstan package (there is no manifest.json).');
  const projectEntry = zip.find('project.json');
  if (!projectEntry) throw new PackageError('The package has no project.json; it is damaged or incomplete.');
  try {
    const manifest = parseManifest(await zip.text(manifestEntry, MAX_JSON_BYTES));
    let project: Project;
    try {
      project = parseProject(JSON.parse(await zip.text(projectEntry, MAX_JSON_BYTES)));
    } catch (e) {
      if (e instanceof ZipError) throw e;
      throw new PackageError(`project.json is not a usable Capstan project: ${(e as Error).message}`);
    }
    const byId = new Map(manifest.media.map((m) => [m.id, m]));
    const blobs = new Map<string, Blob>();
    const problems: string[] = [];
    for (const m of project.media) {
      const listed = byId.get(m.id);
      const entry = listed ? zip.find(listed.path) : undefined;
      if (!listed || !entry) {
        problems.push(`${m.name} is missing from the package`);
        continue;
      }
      try {
        const blob = await zip.blob(entry, { type: m.mime || listed.mime });
        if (listed.bytes >= 0 && blob.size !== listed.bytes) throw new ZipError(`"${m.name}" has the wrong size (${blob.size} bytes, expected ${listed.bytes}).`);
        blobs.set(m.id, blob);
      } catch (e) {
        if (e instanceof ZipError) problems.push(e.message.replace(/\.$/, ''));
        else throw e;
      }
    }
    if (problems.length) {
      throw new PackageError(`The package is damaged: ${problems.slice(0, 4).join('; ')}${problems.length > 4 ? `; and ${problems.length - 4} more problems` : ''}. Nothing was opened.`);
    }
    return { project, manifest, blobs };
  } catch (e) {
    if (e instanceof ZipError) throw new PackageError(e.message);
    throw e;
  }
}

/** True when the first bytes are a zip local-file or empty-archive signature. */
export async function looksLikeZip(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5) && (head[3] === 4 || head[3] === 6);
}
