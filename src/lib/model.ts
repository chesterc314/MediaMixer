/**
 * Shared types and constants for Media Mixer.
 */

/**
 * The longest single media file that may participate in a merge, in seconds.
 * (Spec: "only media of 10 minutes or shorter can be merged".)
 */
/** Editable crossfade bounds; short clips may still be clamped by the engine. */
export const MIN_CROSSFADE_SECONDS = 0.01;
export const MAX_CROSSFADE_SECONDS = 2;

export const MAX_CLIP_SECONDS = 600;

/** The kind of merge a job represents. A job is either all videos or all audios. */
export type JobType = 'video' | 'audio';

/** What a video merge produces: a dissolved MP4, or an audio-only MP3. */
export type MergeOutput = 'video' | 'audio-mp3';

/** Geometry/metadata facts of a clip's primary video track. */
export interface VideoInfo {
  codec: string;
  /** Width/height after aspect-ratio adjustment and rotation (what players show). */
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  flip: boolean;
  /** Rational pixel aspect ratio, reduced form; most videos are 1/1. */
  pixelAspectRatio: { num: number; den: number };
  /** Whether the current browser's WebCodecs can decode this track. */
  canDecode: boolean;
}

/** Facts of a clip's primary audio track. */
export interface AudioInfo {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  canDecode: boolean;
}

/** A validated clip queued for merging. */
export interface ClipInfo {
  id: string;
  file: File | null;
  name: string;
  sizeBytes: number;
  /** 'video' if the file has a video track, otherwise 'audio'. */
  type: JobType;
  /** Duration in seconds (across the file's tracks). */
  duration: number;
  /**
   * Trim window kept from this file, in seconds. `null` means "untrimmed"
   * (0 → duration). Frames outside don't participate in the merge.
   */
  trimStart: number | null;
  trimEnd: number | null;
  video?: VideoInfo;
  audio?: AudioInfo;
  /** Small poster frame object URL (videos only). */
  thumbnailUrl?: string;
}

/** True when the clip's media bytes are not loaded (moved/deleted source). */
export function missingMedia(clip: ClipInfo): boolean {
  return clip.file === null;
}

/** The resident trim values of a clip (fallbacks applied). */
export function clipTrim(clip: ClipInfo): { start: number; end: number } {
  return {
    start: clip.trimStart ?? 0,
    end: clip.trimEnd ?? clip.duration,
  };
}

/** Seconds of content the trim keeps (also validates sane spans). */
export function clippedSpan(clip: ClipInfo): number {
  const { start, end } = clipTrim(clip);
  return Math.max(0, Math.min(end, clip.duration) - Math.min(start, clip.duration));
}

export interface MergeResult {
  blob: Blob;
  fileName: string;
  /** 'copy' = lossless stream copy; 'encode' = decoded and re-encoded to a common format. */
  method: 'copy' | 'encode';
  /** Approximate duration of the merged output, in seconds. */
  duration: number;
  /** File extension for this result (without the dot). */
  extension: 'mp4' | 'm4a' | 'mp3';
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** MM:SS.hh timecode for precise trim labels, e.g. 01:23.45. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––.--';
  const hundredths = Math.round(seconds * 100);
  const minutes = Math.floor(hundredths / 6000);
  const secs = Math.floor((hundredths % 6000) / 100);
  const fraction = hundredths % 100;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`;
}

/** Accepts MM:SS.hh (or SS.hh) and returns seconds, or null for invalid input. */
export function parseTimecode(text: string): number | null {
  const match = text.trim().match(/^(?:(\d+):)?(\d{1,2})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const [, minutesText, secondsText, fractionText] = match;
  const seconds = Number(secondsText);
  if (minutesText !== undefined && seconds >= 60) return null;
  const fraction = Number((fractionText ?? '').padEnd(2, '0')) / 100;
  const total = Number(minutesText ?? 0) * 60 + seconds + fraction;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
