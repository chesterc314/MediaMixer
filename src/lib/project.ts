/**
 * Project persistence for Media Mixer.
 *
 * Two complementary mechanisms:
 *
 *  1. IndexedDB auto-save ("current" project): full copies of the queued
 *     media files + metadata, written automatically while the user works.
 *     On reload the last state is restored silently — a refresh no longer
 *     loses anything.
 *
 *  2. `.mixproj` disk files, which the user saves/opens explicitly. The
 *     container is deliberately tiny — **metadata only** (name, jobType,
 *     clip order/trims/codec facts, and small thumbnails):
 *
 *       ┌─────────┬────────┬────────────────┐
 *       │ magic   │ u32 LE │ header JSON    │
 *       │ MIXPROJv2        │ UTF-8          │
 *       └─────────┴────────┴────────────────┘
 *       then, per clip: │ u32 LE thumb length │ thumb bytes │
 *
 *     Media is never embedded. Opening a project re-links each clip by
 *     identity (name + byte size); clips that can't be linked (source moved
 *     or deleted) surface a per-clip warning and must be Located before
 *     merging. The *current* work — media bytes included — lives in the
 *     IndexedDB auto-save above.
 */
import type { AudioInfo, ClipInfo, JobType, MergeOutput, VideoInfo } from './model';
import { MAX_CROSSFADE_SECONDS } from './model';

/* ------------------------------------------------------------------ */
/* IndexedDB auto-save                                                 */
/* ------------------------------------------------------------------ */

/** A queued clip as persisted locally (File and thumbnail blob included). */
export interface PersistedClip {
  id: string;
  name: string;
  sizeBytes: number;
  type: JobType;
  duration: number;
  trimStart: number | null;
  trimEnd: number | null;
  video?: VideoInfo;
  audio?: AudioInfo;
  /** null = media not linked (moved/deleted since saving); link via Locate. */
  file: File | null;
  thumbnailBlob?: Blob;
}

export interface PersistedProject {
  name: string;
  jobType: JobType | null;
  clips: PersistedClip[];
  savedAt: number;
  /** Optional for compatibility with auto-saves from before crossfade editing. */
  crossfadeSeconds?: number;
  outputFormat?: MergeOutput;
}

export class ProjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStoreError';
  }
}

const DB_NAME = 'media-mixer';
const STORE = 'projects';
const CURRENT_KEY = 'current';
/** Autosave keys live under one version; bump when the schema changes. */
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new ProjectStoreError(request.error?.message ?? 'Could not open the local project store.'));
  });
  return dbPromise;
}

function requestAs<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new ProjectStoreError(request.error?.message ?? 'Local storage request failed.'));
  });
}

/** Writes the working project into the browser's local store (files included). */
export async function saveAutosave(project: PersistedProject): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(project, CURRENT_KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new ProjectStoreError(tx.error?.message ?? 'Auto-save failed.'));
    tx.onabort = () => reject(new ProjectStoreError(tx.error?.message ?? 'Auto-save aborted (storage full?).'));
  });
}

/** Reads the last auto-saved project, or null when none exists. */
export async function loadAutosave(): Promise<PersistedProject | null> {
  const db = await openDb();
  const stored = await requestAs(db.transaction(STORE).objectStore(STORE).get(CURRENT_KEY));
  return (stored as PersistedProject | undefined) ?? null;
}

/** Drops the local auto-save (e.g., when the clip list is emptied). */
export async function clearAutosave(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(CURRENT_KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new ProjectStoreError(tx.error?.message ?? 'Could not clear auto-save.'));
  });
}

/* ------------------------------------------------------------------ */
/* .mixproj disk container                                             */
/* ------------------------------------------------------------------ */

const MAGIC = 'MIXPROJv2';

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/** Clip facts stored in the JSON header — identity is name + byte size. */
interface ClipSpec {
  name: string;
  sizeBytes: number;
  type: JobType;
  duration: number;
  trimStart: number | null;
  trimEnd: number | null;
  video?: VideoInfo;
  audio?: AudioInfo;
  /** false when the clip was already missing its media at save time. */
  hasMedia: boolean;
  fileMime?: string;
  fileLastModified?: number;
  hasThumbnail: boolean;
}

interface ProjectHeader {
  format: typeof MAGIC;
  name: string;
  jobType: JobType | null;
  savedAt: number;
  clips: ClipSpec[];
  /** Optional: older .mixproj files open fine without these fields. */
  crossfadeSeconds?: number;
  outputFormat?: MergeOutput;
}

/** Copies a blob-URL resource (the clip thumbnails) to bytes; safe on failure. */
export async function blobFromUrl(url: string): Promise<Blob | undefined> {
  try {
    return await (await fetch(url)).blob();
  } catch {
    return undefined;
  }
}

/**
 * Serializes a project: metadata-only header + thumbnail bytes, in clip
 * order. Deliberately contains no media — a couple of KiB per clip at most.
 */
export async function buildProjectFile(project: {
  name: string;
  jobType: JobType | null;
  clips: ClipInfo[];
  crossfadeSeconds?: number;
  outputFormat?: MergeOutput;
}): Promise<Blob> {
  const chunks: BlobPart[] = [];
  const encoder = new TextEncoder();

  // Thumbnails are embedded per clip, in the exact order the JSON lists them.
  const thumbnails: Array<Blob | undefined> = [];
  const specs: ClipSpec[] = [];
  for (const clip of project.clips) {
    const thumbnailBlob = clip.thumbnailUrl ? await blobFromUrl(clip.thumbnailUrl) : undefined;
    thumbnails.push(thumbnailBlob);
    specs.push({
      name: clip.name,
      sizeBytes: clip.sizeBytes,
      type: clip.type,
      duration: clip.duration,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      video: clip.video,
      audio: clip.audio,
      hasMedia: clip.file !== null,
      fileMime: clip.file?.type,
      fileLastModified: clip.file?.lastModified,
      hasThumbnail: thumbnailBlob !== undefined,
    });
  }

  const header: ProjectHeader = {
    format: MAGIC,
    name: project.name,
    jobType: project.jobType,
    savedAt: Date.now(),
    clips: specs,
    crossfadeSeconds: project.crossfadeSeconds,
    outputFormat: project.outputFormat,
  };
  const headerJson = encoder.encode(JSON.stringify(header));

  chunks.push(new TextEncoder().encode(MAGIC));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, headerJson.length, true);
  chunks.push(length, headerJson);

  for (let i = 0; i < specs.length; i++) {
    const thumb = thumbnails[i];
    const thumbBytes = thumb ? new Uint8Array(await thumb.arrayBuffer()) : null;

    const thumbLength = new Uint8Array(4);
    new DataView(thumbLength.buffer).setUint32(0, thumbBytes?.length ?? 0, true);
    chunks.push(thumbLength, ...(thumbBytes ? [thumbBytes] : []));
  }

  return new Blob(chunks, { type: 'application/octet-stream' });
}

let nextRestoredClipId = 1;

/**
 * Parses a `.mixproj` file back into a project: clip metadata, order, trims
 * and thumbnails, with every clip's media unlinked (`file: null`) until it
 * is re-linked by identity. Throws ProjectFileError with a friendly reason.
 */
export async function parseProjectFile(file: File): Promise<{
  name: string;
  jobType: JobType | null;
  savedAt: number;
  clips: ClipInfo[];
  crossfadeSeconds: number | null;
  outputFormat: MergeOutput | null;
}> {
  const buffer = await file.arrayBuffer();
  const reject = (reason: string) => new ProjectFileError(reason);
  const view = new DataView(buffer);

  // Fast path for the wrong file kind: magic check first.
  const magicBytes = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(MAGIC.length, buffer.byteLength)));
  if (magicBytes === 'MIXPROJv1') {
    throw reject(
      `"${file.name}" was saved by an older Media Mixer version that embedded media. Re-save the project with the current version.`,
    );
  }
  if (buffer.byteLength < MAGIC.length + 4 || magicBytes !== MAGIC) {
    throw reject(`"${file.name}" is not a Media Mixer project file.`);
  }

  let cursor = MAGIC.length;
  const readU32 = (): number => {
    const value = view.getUint32(cursor, true);
    cursor += 4;
    return value;
  };
  const readBytes = (length: number): Uint8Array<ArrayBuffer> => {
    if (cursor + length > buffer.byteLength) {
      throw reject(`"${file.name}" is corrupted — it ends before its contents do.`);
    }
    const bytes = new Uint8Array(buffer, cursor, length);
    cursor += length;
    return bytes;
  };

  const jsonLength = readU32();
  if (jsonLength > 2 * 1024 * 1024) throw reject(`"${file.name}" has an implausibly large header.`);
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(readBytes(jsonLength)));
  } catch {
    throw reject(`"${file.name}" is corrupted — its header could not be read.`);
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    !('format' in header) ||
    header.format !== MAGIC ||
    !('clips' in header) ||
    !Array.isArray(header.clips)
  ) {
    throw reject(`"${file.name}" is not a Media Mixer project file.`);
  }
  if (header.clips.length > 256) throw reject(`"${file.name}" contains too many clips.`);
  const rawClips: unknown[] = header.clips;
  const rawHeader = header as Record<string, unknown>;

  // The header came from an untrusted file: every field is validated before
  // use, and coercible value ranges (trims, durations, identities) are
  // enforced so downstream code never sees hostile numbers.
  const plainNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const asTrim = (v: unknown, cap: number): number | null =>
    plainNumber(v) ? Math.min(Math.max(v, 0), cap) : null;
  const asString = (v: unknown, cap: number): string | undefined =>
    typeof v === 'string' && v.length <= cap ? v.replace(/[ -]/g, ' ') : undefined;
  const asCodecInfo = (v: unknown, codecCap: number): Record<string, unknown> | undefined => {
    if (typeof v !== 'object' || v === null) return undefined;
    const info = v as Record<string, unknown>;
    if (typeof info.codec !== 'string' || info.codec.length > codecCap || info.codec === '') return undefined;
    const out: Record<string, unknown> = { codec: info.codec, canDecode: info.canDecode === true };
    if (plainNumber(info.displayWidth) && plainNumber(info.displayHeight)) {
      const aspect =
        typeof info.pixelAspectRatio === 'object' && info.pixelAspectRatio !== null
          ? info.pixelAspectRatio as Record<string, unknown>
          : null;
      out.displayWidth = info.displayWidth;
      out.displayHeight = info.displayHeight;
      out.rotation = plainNumber(info.rotation) ? info.rotation : 0;
      out.flip = info.flip === true;
      out.pixelAspectRatio =
        aspect && plainNumber(aspect.num) && plainNumber(aspect.den)
          ? { num: aspect.num, den: aspect.den }
          : { num: 1, den: 1 };
    }
    if (plainNumber(info.sampleRate) && plainNumber(info.numberOfChannels)) {
      out.sampleRate = info.sampleRate;
      out.numberOfChannels = info.numberOfChannels;
    }
    return out;
  };

  const headerName = asString(rawHeader.name, 256) ?? '';
  const headerJobType =
    rawHeader.jobType === 'video' || rawHeader.jobType === 'audio' ? rawHeader.jobType : null;
  const headerCrossfade = plainNumber(rawHeader.crossfadeSeconds)
    ? Math.min(MAX_CROSSFADE_SECONDS, Math.max(0, Math.round(rawHeader.crossfadeSeconds * 100) / 100))
    : null;
  const headerOutputFormat =
    rawHeader.outputFormat === 'video' || rawHeader.outputFormat === 'audio-mp3'
      ? rawHeader.outputFormat
      : null;
  const trustedClips: ClipSpec[] = [];
  for (const raw of rawClips) {
    if (typeof raw !== 'object' || raw === null) throw reject(`"${file.name}" is corrupted — its header is malformed.`);
    const s = raw as Record<string, unknown>;
    const name = asString(s.name, 512);
    const type = s.type === 'video' || s.type === 'audio' ? s.type : null;
    const duration = plainNumber(s.duration) ? Math.min(Math.max(s.duration, 0), 24 * 60 * 60) : null;
    const sizeBytes = plainNumber(s.sizeBytes) && s.sizeBytes >= 0 ? s.sizeBytes : null;
    if (name === undefined || type === null || duration === null || sizeBytes === null) {
      throw reject(`"${file.name}" is corrupted — its header is malformed.`);
    }
    trustedClips.push({
      name,
      sizeBytes,
      type,
      duration,
      trimStart: asTrim(s.trimStart, duration),
      trimEnd: asTrim(s.trimEnd, duration),
      video: asCodecInfo(s.video, 64) as VideoInfo | undefined,
      audio: asCodecInfo(s.audio, 64) as AudioInfo | undefined,
      hasMedia: s.hasMedia === true,
      fileMime: asString(s.fileMime, 100),
      fileLastModified: plainNumber(s.fileLastModified) ? s.fileLastModified : undefined,
      hasThumbnail: s.hasThumbnail === true,
    });
  }
  const trustedHeader: ProjectHeader = {
    format: MAGIC,
    name: headerName,
    jobType: headerJobType,
    savedAt: plainNumber(rawHeader.savedAt) ? rawHeader.savedAt : Date.now(),
    clips: trustedClips,
    crossfadeSeconds: headerCrossfade ?? undefined,
    outputFormat: headerOutputFormat ?? undefined,
  };

  const clips: ClipInfo[] = [];
  for (const spec of trustedHeader.clips) {
    const thumbnailLength = readU32();
    const thumbnail = thumbnailLength > 0 ? readBytes(thumbnailLength) : null;

    clips.push({
      id: `clip-${nextRestoredClipId++}`,
      // Media is never inside the container: clips start unlinked and the
      // caller re-links them (auto-save identity match or per-clip Locate).
      file: null,
      name: spec.name,
      sizeBytes: spec.sizeBytes,
      type: spec.type,
      duration: spec.duration,
      trimStart: spec.trimStart,
      trimEnd: spec.trimEnd,
      video: spec.video,
      audio: spec.audio,
      thumbnailUrl: thumbnail ? URL.createObjectURL(new Blob([thumbnail], { type: 'image/jpeg' })) : undefined,
    });
  }

  return {
    name: trustedHeader.name,
    jobType: trustedHeader.jobType,
    savedAt: trustedHeader.savedAt,
    clips,
    crossfadeSeconds: headerCrossfade,
    outputFormat: headerOutputFormat,
  };
}

/** A filesystem-safe base for `.mixproj` file names, derived from the project name. */
export function slugifyProjectName(name: string): string {
  const slug = name
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
  return slug || 'project';
}
