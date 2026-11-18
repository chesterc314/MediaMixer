'use client';

/**
 * Media Mixer UI. Everything runs client-side: files are inspected with
 * mediabunny's demuxers and merged with the engine in src/lib/merge.ts.
 * No file ever leaves the browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type { SupportReport } from '@/lib/support';
import {
  blobFromUrl,
  buildProjectFile,
  clearAutosave,
  loadAutosave,
  parseProjectFile,
  ProjectFileError,
  saveAutosave,
  slugifyProjectName,
} from '@/lib/project';
import { MAX_CLIP_SECONDS, MAX_CROSSFADE_SECONDS, MIN_CROSSFADE_SECONDS, clipTrim, clippedSpan, formatBytes, formatDuration, formatTimecode, missingMedia, parseTimecode, type ClipInfo, type JobType, type MergeOutput } from '@/lib/model';
import { buildTimeline } from '@/lib/timeline';

interface MergeProgressInfo {
  phase: 'copy' | 'encode';
  fraction: number;
}

interface ResultInfo {
  url: string;
  fileName: string;
  method: 'copy' | 'encode';
  duration: number;
  sizeBytes: number;
  extension: 'mp4' | 'm4a' | 'mp3';
}

interface Notice {
  id: number;
  kind: 'error' | 'info' | 'success';
  text: string;
}

/** One active deck plus one incoming deck lets the preview overlap two clips. */
type PreviewDeck = 0 | 1;

interface PreviewTransition {
  fromDeck: PreviewDeck;
  toDeck: PreviewDeck;
  fromIndex: number;
  toIndex: number;
  /** Fade length in seconds, taken from the same timeline used by Merge. */
  duration: number;
}

interface PreviewFade extends PreviewTransition {
  elapsedMs: number;
  lastFrameMs: number | null;
  frame: number | null;
}

let nextNoticeId = 1;
let nextClipId = 0;

/**
 * Clip keys must stay unique even when a session mixes newly probed files,
 * duplicates, and clips restored from autosave or a .mixproj file (which use
 * their own counters). The time prefix separates page loads; the counter
 * separates clips created within one load.
 */
function createClipId(): string {
  nextClipId++;
  return `clip-${Date.now().toString(36)}-${nextClipId.toString(36)}`;
}

/** Restored clips get fresh keys so they can never collide with new ones. */
function withFreshClipIds<T extends ClipInfo>(clips: T[]): T[] {
  return clips.map((clip) => ({ ...clip, id: createClipId() }));
}

/** The media element a deck uses for a clip's kind. */
function previewElement(
  deck: PreviewDeck,
  clip: ClipInfo | undefined,
  videos: [HTMLVideoElement | null, HTMLVideoElement | null],
  audios: [HTMLAudioElement | null, HTMLAudioElement | null],
): HTMLMediaElement | null {
  if (!clip) return null;
  return clip.type === 'video' ? videos[deck] : audios[deck];
}

/** Characters that are illegal or awkward in saved file names. */
const ILLEGAL_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001F]/g;

/** Accepts `0.75`, `0.75s`, or `00:00.75` for the crossfade length field. */
function parseSecondsInput(text: string): number | null {
  const raw = text.trim().replace(/s$/i, '');
  if (!raw) return null;
  const parsed = raw.includes(':') ? parseTimecode(raw) : Number(raw);
  return parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Live-sanitizer for the rename field: banned chars are swapped, not rejected. */
function sanitizeFileInput(raw: string): string {
  return raw.replace(ILLEGAL_FILE_NAME_CHARS, '_');
}

/** Guarantees a saved name keeps the merge's container extension. */
function withFileExtension(name: string, extension: string): string {
  const trimmed = name.trim();
  return /\.[A-Za-z0-9]{1,8}$/.test(trimmed) ? trimmed : `${trimmed}.${extension}`;
}

export function Mixer() {
  const [clips, setClips] = useState<ClipInfo[]>([]);
  const [jobType, setJobType] = useState<JobType | null>(null);
  const [probing, setProbing] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeProgress, setMergeProgress] = useState<MergeProgressInfo | null>(null);
  const [result, setResult] = useState<ResultInfo | null>(null);
  // Video-only merge options: overlapping joins and audio-only export.
  const [crossfadeSeconds, setCrossfadeSeconds] = useState(0);
  const [lastCrossfadeSeconds, setLastCrossfadeSeconds] = useState(0.5);
  const [outputFormat, setOutputFormat] = useState<MergeOutput>('video');
  // Editable pre-download name; empty falls back to the generated name.
  const [resultName, setResultName] = useState('');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [supportReport, setSupportReport] = useState<SupportReport | null>(null);

  // Project identity + persistence plumbing (auto-save room + .mixproj files).
  const [projectName, setProjectName] = useState('');
  const [restoreDone, setRestoreDone] = useState(false);
  const [lastDiskSave, setLastDiskSave] = useState<number | null>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Crossfade preview: two decks play trimmed windows with overlapping sound
  // and picture, but nothing is rendered or written to disk until Merge.
  const [sequenceOpen, setSequenceOpen] = useState(false);
  const [sequenceIndex, setSequenceIndex] = useState(0);
  const [sequencePaused, setSequencePaused] = useState(false);
  const [sequenceDecks, setSequenceDecks] = useState<[number | null, number | null]>([null, null]);
  const sequenceVideoRefs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const sequenceAudioRefs = useRef<[HTMLAudioElement | null, HTMLAudioElement | null]>([null, null]);
  const sequenceUrlRefs = useRef<[string | null, string | null]>([null, null]);
  const sequenceClipIndexRefs = useRef<[number, number]>([-1, -1]);
  const sequenceActiveDeckRef = useRef<PreviewDeck>(0);
  const sequencePausedRef = useRef(false);
  const sequencePendingRef = useRef<PreviewTransition | null>(null);
  const sequenceFadeRef = useRef<PreviewFade | null>(null);
  const runPreviewFadeFrameRef = useRef<(now: number) => void>(() => undefined);

  const totalDuration = useMemo(() => clips.reduce((s, c) => s + clippedSpan(c), 0), [clips]);
  // Same overlap math as the merge engine; audio jobs never crossfade.
  const previewTimeline = useMemo(
    () => buildTimeline(clips.map(clippedSpan), jobType === 'video' ? crossfadeSeconds : 0),
    [clips, jobType, crossfadeSeconds],
  );
  // Rough estimate shown in the crossfade control (the engine clamps short clips).
  const crossfadeReduction =
    jobType === 'video' && crossfadeSeconds > 0 ? crossfadeSeconds * Math.max(0, clips.length - 1) : 0;
  const totalSize = useMemo(() => clips.reduce((s, c) => s + c.sizeBytes, 0), [clips]);
  const lastClip = clips.length > 0 ? clips[clips.length - 1] : null;
  const sequenceClip = clips[sequenceIndex];

  const setCrossfadeValue = useCallback((value: number) => {
    const clamped = Math.min(
      MAX_CROSSFADE_SECONDS,
      Math.max(MIN_CROSSFADE_SECONDS, Math.round(value * 100) / 100),
    );
    setLastCrossfadeSeconds(clamped);
    setCrossfadeSeconds(clamped);
  }, []);

  useEffect(() => {
    let alive = true;
    void import('@/lib/support').then(async ({ getSupportReport }) => {
      const report = await getSupportReport();
      if (alive) setSupportReport(report);
    });
    return () => {
      alive = false;
    };
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const notify = useCallback((kind: Notice['kind'], text: string) => {
    const id = nextNoticeId++;
    setNotices((prev) => prev.slice(-2).concat({ id, kind, text }));
    if (kind !== 'error') {
      setTimeout(() => setNotices((prev) => prev.filter((n) => n.id !== id)), 5000);
    }
  }, []);

  const revokeAllThumbnails = useCallback((list: ClipInfo[]) => {
    for (const clip of list) {
      if (clip.thumbnailUrl) URL.revokeObjectURL(clip.thumbnailUrl);
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /* Projects: auto-save locally, restore after reload                  */
  /* ---------------------------------------------------------------- */

  // Once per page load: bring back the auto-saved project (with media bytes).
  useEffect(() => {
    void (async () => {
      try {
        const autosave = await loadAutosave();
        if (autosave && autosave.clips.length > 0) {
          setProjectName(autosave.name);
          setJobType(autosave.jobType);
          if (autosave.crossfadeSeconds !== undefined) {
            setCrossfadeSeconds(autosave.crossfadeSeconds);
            if (autosave.crossfadeSeconds > 0) setLastCrossfadeSeconds(autosave.crossfadeSeconds);
          }
          if (autosave.outputFormat) setOutputFormat(autosave.outputFormat);
          setClips(
            withFreshClipIds(autosave.clips).map((clip) => ({
              ...clip,
              thumbnailUrl: clip.thumbnailBlob ? URL.createObjectURL(clip.thumbnailBlob) : undefined,
            })),
          );
          notify(
            'info',
            `Restored your last project — ${autosave.clips.length} clip${autosave.clips.length === 1 ? '' : 's'} ready to merge.`,
          );
        }
      } catch {
        /* A failed restore must never block the app; auto-save retries on edits. */
      } finally {
        setRestoreDone(true);
      }
    })();
  }, [notify]);

  // Debounced auto-save after any project change. The media Files themselves
  // are stored too, so a reload rebuilds the merge queue exactly as it was.
  useEffect(() => {
    if (!restoreDone) return;
    if (clips.length === 0) {
      void clearAutosave().catch(() => undefined);
      return;
    }
    const handle = setTimeout(() => {
      void (async () => {
        try {
          await saveAutosave({
            name: projectName,
            jobType,
            crossfadeSeconds: jobType === 'video' ? crossfadeSeconds : 0,
            outputFormat: jobType === 'video' ? outputFormat : 'video',
            savedAt: Date.now(),
            clips: await Promise.all(
              clips.map(async (clip) => ({
                ...clip,
                thumbnailBlob: clip.thumbnailUrl ? await blobFromUrl(clip.thumbnailUrl) : undefined,
              })),
            ),
          });
        } catch {
          notify('error', 'Auto-save failed (browser storage). Use "Save project" for a copy on disk.');
        }
      })();
    }, 600);
    return () => clearTimeout(handle);
  }, [clips, jobType, projectName, crossfadeSeconds, outputFormat, restoreDone, notify]);

  // Warn before leaving (refresh/close) while clips are queued. Browsers show
  // their own wording; auto-save still has the project back afterwards.
  useEffect(() => {
    if (clips.length === 0) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [clips.length]);

  /* ---------------------------------------------------------------- */
  /* Adding files                                                      */
  /* ---------------------------------------------------------------- */

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setProbing((prev) => prev.concat(files.map((f) => f.name)));
      try {
        const { probeFile } = await import('@/lib/probe');
        const outcomes = await Promise.all(
          files.map(async (f) => ({ outcome: await probeFile(f) })),
        );

        for (const { outcome } of outcomes) {
          if (!outcome.ok) {
            notify('error', outcome.reason);
            continue;
          }
          const clip = outcome.clip;
          if (clip.duration > MAX_CLIP_SECONDS) {
            notify(
              'error',
              `Skipped "${clip.name}" — it is ${formatDuration(clip.duration)} long. Only media up to 10 minutes can be merged.`,
            );
            continue;
          }
          if (jobType && clip.type !== jobType) {
            notify(
              'error',
              `Skipped "${clip.name}" — this is a ${jobType} merge, and that file is ${clip.type === 'video' ? 'a video' : 'an audio file'}.`,
            );
            continue;
          }
          setClips((prev) => prev.concat({ ...clip, id: createClipId() }));
          if (!jobType) setJobType(clip.type);
        }
      } finally {
        setProbing((prev) => prev.filter((name) => !files.some((f) => f.name === name)));
      }
    },
    [jobType, notify],
  );

  const removeClip = useCallback(
    (id: string) => {
      setClips((prev) => {
        const clip = prev.find((c) => c.id === id);
        if (clip?.thumbnailUrl) URL.revokeObjectURL(clip.thumbnailUrl);
        const next = prev.filter((c) => c.id !== id);
        if (next.length === 0) setJobType(null);
        return next;
      });
    },
    [],
  );

  const moveClip = useCallback((id: string, direction: 'up' | 'down') => {
    setClips((prev) => {
      const index = prev.findIndex((c) => c.id === id);
      const target = direction === 'up' ? index - 1 : index + 1;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }, []);

  const setClipTrim = useCallback((id: string, trim: { start: number; end: number } | null) => {
    setClips((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, trimStart: trim ? Math.max(0, trim.start) : null, trimEnd: trim ? trim.end : null }
          : c,
      ),
    );
  }, []);

  // Copies a clip (including its trim window) so the same span can be queued
  // more than once in a merge. The media File is shared; the thumbnail gets
  // its own object URL so revoking one card can't break the other.
  const duplicateClip = useCallback(
    async (id: string) => {
      const source = clips.find((c) => c.id === id);
      if (!source) return;
      let thumbnailUrl = source.thumbnailUrl;
      if (thumbnailUrl) {
        const bytes = await blobFromUrl(thumbnailUrl);
        thumbnailUrl = bytes ? URL.createObjectURL(bytes) : undefined;
      }
      const copy: ClipInfo = { ...source, id: createClipId(), thumbnailUrl };
      setClips((prev) => {
        const index = prev.findIndex((c) => c.id === id);
        if (index === -1) return prev;
        const next = prev.slice();
        next.splice(index + 1, 0, copy);
        return next;
      });
      notify('success', `Duplicated "${source.name}" with its trim — ready to merge again.`);
    },
    [clips, notify],
  );

  /* ---------------------------------------------------------------- */
  /* Crossfade preview (no merge)                                      */
  /* ---------------------------------------------------------------- */

  const syncPaused = useCallback((paused: boolean) => {
    sequencePausedRef.current = paused;
    setSequencePaused(paused);
  }, []);

  const resetPreviewDeck = useCallback((deck: PreviewDeck) => {
    for (const el of [sequenceVideoRefs.current[deck], sequenceAudioRefs.current[deck]]) {
      if (!el) continue;
      el.pause();
      el.removeAttribute('src');
      el.load();
      el.volume = 1;
      el.style.opacity = '1';
    }
    const url = sequenceUrlRefs.current[deck];
    if (url) URL.revokeObjectURL(url);
    sequenceUrlRefs.current[deck] = null;
    sequenceClipIndexRefs.current[deck] = -1;
  }, []);

  const clearPreviewDecks = useCallback(() => {
    sequencePendingRef.current = null;
    const fade = sequenceFadeRef.current;
    if (fade?.frame !== null && fade?.frame !== undefined) cancelAnimationFrame(fade.frame);
    sequenceFadeRef.current = null;
    resetPreviewDeck(0);
    resetPreviewDeck(1);
    sequenceActiveDeckRef.current = 0;
    setSequenceDecks([null, null]);
  }, [resetPreviewDeck]);

  const stopSequence = useCallback(() => {
    clearPreviewDecks();
    setSequenceIndex(0);
    syncPaused(false);
    setSequenceOpen(false);
  }, [clearPreviewDecks, syncPaused]);

  const finishPreviewFade = useCallback(() => {
    const fade = sequenceFadeRef.current;
    if (!fade) return;
    sequenceFadeRef.current = null;
    if (fade.frame !== null) cancelAnimationFrame(fade.frame);

    resetPreviewDeck(fade.fromDeck);
    const clip = clips[fade.toIndex];
    const el = previewElement(fade.toDeck, clip, sequenceVideoRefs.current, sequenceAudioRefs.current);
    if (el) {
      el.volume = 1;
      el.style.opacity = '1';
    }
    sequenceActiveDeckRef.current = fade.toDeck;
    setSequenceIndex(fade.toIndex);
    syncPaused(false);
  }, [clips, resetPreviewDeck, syncPaused]);

  const runPreviewFadeFrame = useCallback(
    (now: number) => {
      const fade = sequenceFadeRef.current;
      if (!fade) return;
      if (fade.lastFrameMs !== null) fade.elapsedMs += Math.max(0, now - fade.lastFrameMs);
      fade.lastFrameMs = now;
      const progress = fade.duration > 0 ? Math.min(1, fade.elapsedMs / (fade.duration * 1000)) : 1;

      for (const [index, deck, gain] of [
        [fade.fromIndex, fade.fromDeck, 1 - progress],
        [fade.toIndex, fade.toDeck, progress],
      ] as const) {
        const el = previewElement(deck, clips[index], sequenceVideoRefs.current, sequenceAudioRefs.current);
        if (el) {
          el.volume = gain;
          if (el instanceof HTMLVideoElement) el.style.opacity = String(gain);
        }
      }

      if (progress >= 1) {
        finishPreviewFade();
        return;
      }
      fade.frame = requestAnimationFrame((now) => runPreviewFadeFrameRef.current(now));
    },
    [clips, finishPreviewFade],
  );

  useEffect(() => {
    runPreviewFadeFrameRef.current = runPreviewFadeFrame;
  }, [runPreviewFadeFrame]);

  const startPreviewFade = useCallback(
    (deck: PreviewDeck) => {
      const pending = sequencePendingRef.current;
      if (!pending || pending.toDeck !== deck || sequencePausedRef.current) return;
      const clip = clips[pending.toIndex];
      const el = previewElement(deck, clip, sequenceVideoRefs.current, sequenceAudioRefs.current);
      if (!clip || !el || el.readyState < 1) return;

      const trim = clipTrim(clip);
      el.currentTime = Math.min(trim.start, Math.max(0, clip.duration - 0.01));
      el.volume = 0;
      el.style.opacity = '0';
      sequencePendingRef.current = null;

      const fade: PreviewFade = { ...pending, elapsedMs: 0, lastFrameMs: null, frame: null };
      sequenceFadeRef.current = fade;

      const outgoing = previewElement(
        pending.fromDeck,
        clips[pending.fromIndex],
        sequenceVideoRefs.current,
        sequenceAudioRefs.current,
      );
      if (outgoing?.paused) void outgoing.play().catch(() => undefined);
      void el
        .play()
        .then(() => {
          if (sequenceFadeRef.current === fade && fade.frame === null && !sequencePausedRef.current) {
            fade.frame = requestAnimationFrame(runPreviewFadeFrame);
          }
        })
        .catch(() => notify('error', 'Playback was blocked by the browser — press play in the preview.'));
    },
    [clips, notify, runPreviewFadeFrame],
  );

  /** Loads one clip into a deck. loadedmetadata seeks and starts playback. */
  const loadSequenceDeck = useCallback(
    (deck: PreviewDeck, index: number, gain = 1) => {
      const clip = clips[index];
      if (!clip?.file) return false;
      resetPreviewDeck(deck);
      const el = previewElement(deck, clip, sequenceVideoRefs.current, sequenceAudioRefs.current);
      if (!el) return false;

      const url = URL.createObjectURL(clip.file);
      sequenceUrlRefs.current[deck] = url;
      sequenceClipIndexRefs.current[deck] = index;
      el.src = url;
      el.volume = gain;
      el.style.opacity = String(gain);
      setSequenceDecks((prev) => {
        const next: [number | null, number | null] = [prev[0], prev[1]];
        next[deck] = index;
        return next;
      });
      el.load();
      return true;
    },
    [clips, resetPreviewDeck],
  );

  // Skips clips with missing media and loads the next trimmed window.
  const playSequenceAt = useCallback(
    (index: number) => {
      let at = index;
      while (at < clips.length && missingMedia(clips[at]!)) at++;
      if (at >= clips.length) {
        stopSequence();
        return;
      }
      clearPreviewDecks();
      sequenceActiveDeckRef.current = 0;
      if (!loadSequenceDeck(0, at)) return;
      setSequenceIndex(at);
      syncPaused(false);
    },
    [clips, clearPreviewDecks, loadSequenceDeck, stopSequence, syncPaused],
  );

  const findNextClip = useCallback(
    (from: number) => {
      for (let i = from + 1; i < clips.length; i++) {
        if (!missingMedia(clips[i]!)) return i;
      }
      return -1;
    },
    [clips],
  );

  /** Starts the incoming deck at the outgoing clip's fade-out point. */
  const beginCrossfade = useCallback(
    (fromDeck: PreviewDeck, fromIndex: number, toIndex: number, duration: number) => {
      const fromClip = clips[fromIndex]!;
      const outgoing = previewElement(
        fromDeck,
        fromClip,
        sequenceVideoRefs.current,
        sequenceAudioRefs.current,
      );
      const trim = clipTrim(fromClip);
      if (outgoing) outgoing.currentTime = Math.max(trim.start, trim.end - duration);

      const toDeck: PreviewDeck = fromDeck === 0 ? 1 : 0;
      sequencePendingRef.current = { fromDeck, toDeck, fromIndex, toIndex, duration };
      if (!loadSequenceDeck(toDeck, toIndex, 0)) {
        sequencePendingRef.current = null;
        playSequenceAt(toIndex);
      }
    },
    [clips, loadSequenceDeck, playSequenceAt],
  );

  const startSequence = useCallback(() => {
    if (clips.length === 0 || clips.every(missingMedia)) return;
    setSequenceOpen(true);
    playSequenceAt(0);
  }, [clips, playSequenceAt]);

  const onSequenceLoadedMetadata = (deck: PreviewDeck) => {
    const index = sequenceClipIndexRefs.current[deck];
    const clip = clips[index];
    const el = previewElement(deck, clip, sequenceVideoRefs.current, sequenceAudioRefs.current);
    if (!clip || !el) return;
    el.currentTime = Math.min(clipTrim(clip).start, Math.max(0, clip.duration - 0.01));
    if (sequencePendingRef.current?.toDeck === deck) {
      startPreviewFade(deck);
      return;
    }
    el.volume = 1;
    el.style.opacity = '1';
    void el.play().catch(() => notify('error', 'Playback was blocked by the browser — press play in the preview.'));
  };

  const onSequenceTimeUpdate = (deck: PreviewDeck) => {
    if (sequencePendingRef.current || sequenceFadeRef.current) return;
    if (deck !== sequenceActiveDeckRef.current) return;
    const index = sequenceClipIndexRefs.current[deck];
    const clip = clips[index];
    const el = previewElement(deck, clip, sequenceVideoRefs.current, sequenceAudioRefs.current);
    if (!clip || !el || el.paused) return;

    const trim = clipTrim(clip);
    const nextIndex = findNextClip(index);
    const fade = previewTimeline.fadesOut[index] ?? 0;
    // Only adjacent, present clips share the overlap the merge will create.
    if (fade > 0 && nextIndex === index + 1) {
      if (el.currentTime >= trim.end - fade - 0.03) beginCrossfade(deck, index, nextIndex, fade);
      return;
    }
    if (el.currentTime >= trim.end - 0.03) {
      if (nextIndex >= 0) playSequenceAt(nextIndex);
      else stopSequence();
    }
  };

  const onSequenceEnded = (deck: PreviewDeck) => {
    if (sequencePendingRef.current || sequenceFadeRef.current) return;
    if (deck !== sequenceActiveDeckRef.current) return;
    const nextIndex = findNextClip(sequenceClipIndexRefs.current[deck]);
    if (nextIndex >= 0) playSequenceAt(nextIndex);
    else stopSequence();
  };

  const toggleSequencePause = () => {
    if (sequencePausedRef.current) {
      syncPaused(false);
      const pending = sequencePendingRef.current;
      if (pending) startPreviewFade(pending.toDeck);
      if (!sequenceFadeRef.current) {
        for (const deck of [0, 1] as const) {
          const clip = clips[sequenceClipIndexRefs.current[deck]];
          const el = previewElement(deck, clip, sequenceVideoRefs.current, sequenceAudioRefs.current);
          if (el?.paused) void el.play().catch(() => notify('error', 'Playback was blocked by the browser.'));
        }
      } else {
        const fade = sequenceFadeRef.current;
        if (fade.frame === null) fade.frame = requestAnimationFrame(runPreviewFadeFrame);
        const outgoing = previewElement(
          fade.fromDeck,
          clips[fade.fromIndex],
          sequenceVideoRefs.current,
          sequenceAudioRefs.current,
        );
        if (outgoing?.paused) void outgoing.play().catch(() => undefined);
      }
      return;
    }

    syncPaused(true);
    for (const deck of [0, 1] as const) {
      for (const el of [sequenceVideoRefs.current[deck], sequenceAudioRefs.current[deck]]) {
        if (el) el.pause();
      }
    }
    const fade = sequenceFadeRef.current;
    if (fade) {
      if (fade.frame !== null) cancelAnimationFrame(fade.frame);
      fade.frame = null;
      fade.lastFrameMs = null;
    }
  };

  useEffect(() => () => clearPreviewDecks(), [clearPreviewDecks]);

  const clearAll = useCallback(() => {
    stopSequence();
    setClips((prev) => {
      revokeAllThumbnails(prev);
      return [];
    });
    setJobType(null);
    setCrossfadeSeconds(0);
    setLastCrossfadeSeconds(0.5);
    setOutputFormat('video');
    setProjectName('');
    setLastDiskSave(null);
    void clearAutosave().catch(() => undefined);
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, [revokeAllThumbnails, stopSequence]);

  /* ---------------------------------------------------------------- */
  /* Projects: .mixproj save / open on disk                            */
  /* ---------------------------------------------------------------- */

  const saveProjectToDisk = useCallback(async () => {
    if (clips.length === 0) return;
    try {
      const blob = await buildProjectFile({
        name: projectName,
        jobType,
        clips,
        crossfadeSeconds: jobType === 'video' ? crossfadeSeconds : 0,
        outputFormat: jobType === 'video' ? outputFormat : 'video',
      });
      const fileName = `${slugifyProjectName(projectName)}.mixproj`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setLastDiskSave(Date.now());
      notify('success', `Project saved as "${fileName}" — clips, order, trims, crossfade, export and thumbnails (media is re-linked on open).`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Saving the project failed unexpectedly.');
    }
  }, [clips, jobType, projectName, crossfadeSeconds, outputFormat, notify]);

  // Re-links missing clips by identity (name + byte size) against the files
  // still stored in the local auto-save, so reopening a project on the same
  // browser usually needs no re-picking at all.
  const relinkFromAutosave = useCallback(async (target: ClipInfo[]): Promise<ClipInfo[]> => {
    try {
      const autosave = await loadAutosave();
      const byIdentity = new Map<string, File>();
      for (const saved of autosave?.clips ?? []) {
        if (saved.file) byIdentity.set(`${saved.name}::${saved.sizeBytes}`, saved.file);
      }
      return target.map((clip) =>
        clip.file ? clip : { ...clip, file: byIdentity.get(`${clip.name}::${clip.sizeBytes}`) ?? null },
      );
    } catch {
      return target;
    }
  }, []);

  // Binds a user-picked file onto one missing clip. The name must match; if
  // the bytes changed since saving (same name, different size), the clip is
  // re-probed so its metadata matches the new reality.
  const locateClipMedia = useCallback(
    async (id: string, picked: File) => {
      const target = clips.find((c) => c.id === id);
      if (!target || target.file) return;
      if (picked.name !== target.name) {
        notify('error', `That is "${picked.name}", but the project expects "${target.name}".`);
        return;
      }
      if (picked.size === target.sizeBytes) {
        setClips((prev) => prev.map((c) => (c.id === id ? { ...c, file: picked } : c)));
        notify('success', `Relinked "${target.name}" — trims and metadata restored.`);
        return;
      }
      try {
        const { probeFile } = await import('@/lib/probe');
        const outcome = await probeFile(picked);
        if (!outcome.ok) {
          notify('error', outcome.reason);
          return;
        }
        const probed = outcome.clip;
        if (probed.type !== target.type) {
          notify('error', `"${target.name}" is now a ${probed.type} file, but the project expects a ${target.type}.`);
          return;
        }
        setClips((prev) =>
          prev.map((c) =>
            c.id !== id
              ? c
              : {
                  ...c,
                  file: picked,
                  sizeBytes: picked.size,
                  duration: probed.duration,
                  video: probed.video,
                  audio: probed.audio,
                  thumbnailUrl: probed.thumbnailUrl,
                  trimStart: c.trimStart !== null ? Math.min(c.trimStart, Math.max(0, probed.duration - 0.1)) : null,
                  trimEnd: c.trimEnd !== null ? Math.min(c.trimEnd, probed.duration) : null,
                },
          ),
        );
        if (target.thumbnailUrl) URL.revokeObjectURL(target.thumbnailUrl);
        notify('success', `Relinked "${target.name}" — the file changed on disk, so its metadata was re-checked.`);
      } catch {
        notify('error', `Could not inspect "${picked.name}".`);
      }
    },
    [clips, notify],
  );

  const openProjectFile = useCallback(
    async (file: File) => {
      try {
        const project = await parseProjectFile(file);
        if (project.clips.length === 0) {
          notify('error', `"${file.name}" contains no clips.`);
          return;
        }
        revokeAllThumbnails(clips);
        const loaded = withFreshClipIds(await relinkFromAutosave(project.clips));
        const stillMissing = loaded.filter(missingMedia).length;
        setJobType(project.jobType ?? loaded[0]!.type);
        setProjectName(project.name);
        const restoredCrossfade = project.crossfadeSeconds ?? 0;
        setCrossfadeSeconds(restoredCrossfade);
        if (restoredCrossfade > 0) setLastCrossfadeSeconds(restoredCrossfade);
        setOutputFormat(project.outputFormat ?? 'video');
        setClips(loaded);
        setLastDiskSave(null);
        setResult((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return null;
        });
        try {
          // The opened project becomes the working auto-save immediately.
          await saveAutosave({
            name: project.name,
            jobType: project.jobType ?? loaded[0]!.type,
            crossfadeSeconds: restoredCrossfade,
            outputFormat: project.outputFormat ?? 'video',
            savedAt: Date.now(),
            clips: await Promise.all(
              loaded.map(async (clip) => ({
                ...clip,
                thumbnailBlob: clip.thumbnailUrl ? await blobFromUrl(clip.thumbnailUrl) : undefined,
              })),
            ),
          });
        } catch {
          /* Non-fatal: disk copy still exists; auto-save retried on edits. */
        }
        notify(
          stillMissing > 0 ? 'info' : 'success',
          stillMissing > 0
            ? `Loaded "${project.name || file.name}" — ${loaded.length} clip${loaded.length === 1 ? '' : 's'}; ${stillMissing} ${stillMissing === 1 ? 'is' : 'are'} missing media (moved or deleted?) — use Locate on ${stillMissing === 1 ? 'its' : 'their'} card${stillMissing === 1 ? '' : 's'}.`
            : `Loaded "${project.name || file.name}" — all ${loaded.length} clip${loaded.length === 1 ? '' : 's'} linked and ready to merge.`,
        );
      } catch (err) {
        notify('error', err instanceof ProjectFileError ? err.message : `Could not open "${file.name}".`);
      }
    },
    [clips, relinkFromAutosave, revokeAllThumbnails, notify],
  );

  const onProjectInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) void openProjectFile(file);
    },
    [openProjectFile],
  );

  /* ---------------------------------------------------------------- */
  /* Merging                                                           */
  /* ---------------------------------------------------------------- */

  const startMerge = useCallback(async () => {
    if (clips.length < 2) {
      notify('error', 'Add at least two clips to merge.');
      return;
    }
    const missingCount = clips.filter(missingMedia).length;
    if (missingCount > 0) {
      notify(
        'error',
        `${missingCount} ${missingCount === 1 ? 'clip is' : 'clips are'} missing media — use Locate on ${
          missingCount === 1 ? 'its' : 'their'
        } card${missingCount === 1 ? '' : 's'} first.`,
      );
      return;
    }
    const crossfade = jobType === 'video' ? crossfadeSeconds : 0;
    const exportFormat: MergeOutput = jobType === 'video' ? outputFormat : 'video';
    stopSequence();
    const controller = new AbortController();
    abortRef.current = controller;
    setMerging(true);
    setMergeProgress(null);
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });

    try {
      const { mergeClips } = await import('@/lib/merge');
      let last = -1;
      const mergeResult = await mergeClips(clips, {
        jobType: jobType!,
        crossfadeSeconds: crossfade,
        outputFormat: exportFormat,
        signal: controller.signal,
        onProgress: ({ phase, fraction }) => {
          const pct = Math.floor(fraction * 100);
          if (pct !== last || mergeProgress === null) {
            last = pct;
            setMergeProgress({ phase, fraction });
          }
        },
      });

      const url = URL.createObjectURL(mergeResult.blob);
      setResult({
        url,
        fileName: mergeResult.fileName,
        method: mergeResult.method,
        duration: mergeResult.duration,
        sizeBytes: mergeResult.blob.size,
        extension: mergeResult.extension,
      });
      setResultName(mergeResult.fileName);
      if (exportFormat === 'audio-mp3') {
        notify('success', `Merged ${clips.length} soundtracks into one MP3 with ${crossfade.toFixed(2)} s crossfades.`);
      } else if (crossfade > 0) {
        notify('success', `Merged with ${crossfade.toFixed(2)} s video and audio crossfades at each join.`);
      } else {
        notify(
          'success',
          mergeResult.method === 'copy'
            ? 'Merged losslessly — the original streams were copied byte-for-byte.'
            : 'Merged — mixed sources were decoded and re-encoded to one common format.',
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'MergeCanceledError') {
        notify('info', 'Merge canceled.');
      } else {
        notify('error', err instanceof Error ? err.message : 'Merging failed unexpectedly.');
      }
    } finally {
      abortRef.current = null;
      setMerging(false);
      setMergeProgress(null);
    }
  }, [clips, jobType, crossfadeSeconds, outputFormat, notify, mergeProgress, stopSequence]);

  const cancelMerge = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /* ---------------------------------------------------------------- */
  /* Drag & drop + paste                                               */
  /* ---------------------------------------------------------------- */

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      void addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles],
  );

  const onFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      void addFiles(Array.from(e.target.files ?? []));
      e.target.value = '';
    },
    [addFiles],
  );

  const pickFiles = useCallback(() => fileInputRef.current?.click(), []);

  const toggleTheme = () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('media-mixer-theme', theme);
    } catch (error) {
      console.warn('Theme preference could not be saved:', error);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-10">
      {/* Header ---------------------------------------------------------- */}
      <header className="mb-8 select-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Media Mixer</h1>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleTheme}
              className="h-9 rounded-full border border-zinc-300 px-3 text-sm font-medium text-foreground hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 dark:border-zinc-600 dark:hover:bg-zinc-800 dark:focus-visible:outline-blue-400"
            >
              <span className="dark:hidden">Dark mode</span>
              <span className="hidden dark:inline">Light mode</span>
            </button>
            <a
              href="https://www.buymeacoffee.com/ccobus"
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:opacity-80"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- Third-party button API serves its own image. */}
              <img
                src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20beer&emoji=%F0%9F%8D%BA&slug=ccobus&button_colour=BD5FFF&font_colour=ffffff&font_family=Cookie&outline_colour=000000&coffee_colour=FFDD00"
                alt="Buy me a beer"
                className="h-9 rounded-full"
              />
            </a>
          </div>
        </div>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Join any number of videos — or audios — into one file, right in your browser. Files never leave your device.
        </p>
      </header>

      {/* Project bar ---------------------------------------------------- */}
      <section className="mb-6 flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
        <input
          value={projectName}
          onChange={(e) => setProjectName(sanitizeFileInput(e.target.value))}
          onBlur={() => setProjectName((v) => v.trim())}
          placeholder="Untitled project"
          aria-label="Project name"
          title="Name this project — it is used for the .mixproj file name"
          className="h-9 w-56 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-foreground outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          onClick={() => projectInputRef.current?.click()}
          className="h-9 rounded-full border border-zinc-300 px-3 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Open project…
        </button>
        <button
          onClick={saveProjectToDisk}
          disabled={merging || clips.length === 0}
          title="Download the project as a tiny .mixproj file (metadata only — media is re-linked when opened)"
          className="h-9 rounded-full border border-zinc-300 px-3 text-sm hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Save project
        </button>
        <span className="ml-auto text-xs text-zinc-600 dark:text-zinc-400">
          {lastDiskSave
            ? `saved to disk ${new Date(lastDiskSave).toLocaleTimeString()}`
            : 'auto-saved locally as you work'}
        </span>
        <input ref={projectInputRef} type="file" accept=".mixproj" className="hidden" onChange={onProjectInput} />
      </section>

      {/* Browser support -------------------------------------------- */}
      {supportReport && !supportReport.supported && (
        <div className="mb-6 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="font-medium">This browser can&apos;t run merges:</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 opacity-90">
            {supportReport.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {supportReport?.supported && supportReport.warnings.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="font-medium">This browser can merge with limitations:</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 opacity-90">
            {supportReport.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Drop zone ---------------------------------------------------- */}
      <section
        role="button"
        tabIndex={0}
        aria-label="Add media files"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={pickFiles}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && pickFiles()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
          dragOver
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10'
            : 'border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600'
        }`}
      >
        <p className="text-sm font-medium text-foreground">Drop {jobType ? `${jobType} files` : 'video or audio files'} here</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          or click to choose · each file must be ≤ 10:00 · {jobType ? `only ${jobType} files accepted` : 'mixing types is not allowed'}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*"
          className="hidden"
          onChange={onFileInput}
        />
      </section>

      {(clips.length > 0 || probing.length > 0) && (
        <section className="mt-6">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Clips ({clips.length})
              {jobType && (
                <span className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-xs normal-case dark:bg-zinc-800">
                  {jobType} merge
                </span>
              )}
            </h2>
            <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              <span>
                total {formatDuration(totalDuration)} · {formatBytes(totalSize)}
              </span>
              <button
                onClick={startSequence}
                className="font-medium text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400"
                disabled={clips.length === 0 || clips.every(missingMedia) || merging}
                title="Play each clip's trimmed span in order, without merging"
              >
                ▶ Play all
              </button>
              <button
                onClick={clearAll}
                className="font-medium text-red-600 hover:underline dark:text-red-400"
                disabled={merging}
              >
                Clear all
              </button>
            </div>
          </div>

          <div className={`mt-3 rounded-lg border border-blue-200 p-3 dark:border-blue-900 ${sequenceOpen ? '' : 'hidden'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-blue-800 dark:text-blue-300">
                Previewing {sequenceIndex + 1} of {clips.length}
                {sequenceClip && (
                  <>
                    {' — '}
                    {sequenceClip.name}
                    <span className="ml-1 font-normal text-zinc-500">({formatDuration(clippedSpan(sequenceClip))})</span>
                  </>
                )}
              </p>
              <div className="flex items-center gap-2 text-xs">
                <button
                  onClick={toggleSequencePause}
                  className="rounded-full border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  {sequencePaused ? '▶ Resume' : '⏸ Pause'}
                </button>
                <button
                  onClick={stopSequence}
                  className="rounded-full border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  ⏹ Stop
                </button>
              </div>
            </div>
            <div className="mt-2 grid">
              {([0, 1] as const).map((deck) => {
                const deckClip = clips[sequenceDecks[deck] ?? -1];
                return (
                  <div
                    key={deck}
                    style={{ gridArea: '1 / 1' }}
                    className={deckClip ? '' : 'hidden'}
                    data-preview-deck={deck}
                  >
                    <div className={deckClip?.type === 'video' ? '' : 'hidden'}>
                      <video
                        ref={(el) => {
                          sequenceVideoRefs.current[deck] = el;
                        }}
                        controls
                        className="max-h-60 w-full rounded bg-black"
                        onLoadedMetadata={() => onSequenceLoadedMetadata(deck)}
                        onTimeUpdate={() => onSequenceTimeUpdate(deck)}
                        onEnded={() => onSequenceEnded(deck)}
                      />
                    </div>
                    <div className={deckClip?.type === 'audio' ? '' : 'hidden'}>
                      <audio
                        ref={(el) => {
                          sequenceAudioRefs.current[deck] = el;
                        }}
                        controls
                        className="w-full"
                        onLoadedMetadata={() => onSequenceLoadedMetadata(deck)}
                        onTimeUpdate={() => onSequenceTimeUpdate(deck)}
                        onEnded={() => onSequenceEnded(deck)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Plays each trimmed span in order with the configured crossfade. Nothing is merged until you press Merge.
            </p>
          </div>

          <ol className="mt-3 space-y-2">
            {clips.map((clip, index) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                isFirst={index === 0}
                isLast={index === clips.length - 1}
                disabled={merging}
                onRemove={() => removeClip(clip.id)}
                onDuplicate={() => void duplicateClip(clip.id)}
                onMove={(dir) => moveClip(clip.id, dir)}
                onSetTrim={(trim) => setClipTrim(clip.id, trim)}
                onLocate={(file) => void locateClipMedia(clip.id, file)}
              />
            ))}
          </ol>

          {probing.length > 0 && (
            <p className="mt-2 text-xs italic text-zinc-500 dark:text-zinc-400">
              Inspecting {probing.length === 1 ? probing[0] : `${probing.length} files`}…
            </p>
          )}

          {jobType === 'video' && clips.length > 0 && (
            <div className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              <label className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={crossfadeSeconds > 0}
                  disabled={merging || clips.length < 2}
                  aria-label="Enable crossfade"
                  onChange={(e) => setCrossfadeSeconds(e.target.checked ? lastCrossfadeSeconds : 0)}
                  className="h-4 w-4 accent-blue-600"
                />
                Crossfade clips
              </label>
              <CrossfadeLengthControl
                value={crossfadeSeconds || lastCrossfadeSeconds}
                disabled={merging || crossfadeSeconds === 0}
                onChange={setCrossfadeValue}
              />
              <label className="flex items-center gap-2">
                <span className="text-zinc-500 dark:text-zinc-400">Export</span>
                <select
                  value={outputFormat}
                  disabled={merging}
                  aria-label="Export format"
                  onChange={(e) => setOutputFormat(e.target.value as MergeOutput)}
                  className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-800"
                >
                  <option value="video">Video (MP4)</option>
                  <option value="audio-mp3">Audio only (MP3)</option>
                </select>
              </label>
              {crossfadeSeconds > 0 && clips.length > 1 && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  ≈ {formatDuration(Math.max(0, totalDuration - crossfadeReduction))} after overlaps
                </span>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-4">
            {!merging ? (
              <button
                onClick={startMerge}
                disabled={clips.length < 2 || clips.some(missingMedia) || (supportReport !== null && !supportReport.supported)}
                title={
                  clips.some(missingMedia)
                    ? 'Relink the missing clips first (⤒ locate on each card)'
                    : undefined
                }
                className="h-11 rounded-full bg-blue-700 px-6 font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-600 dark:hover:bg-blue-700"
              >
                Merge {clips.length} clips
              </button>
            ) : (
              <>
                <div className="flex h-11 min-w-64 flex-1 items-center gap-3">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-all"
                      style={{ width: `${((mergeProgress?.fraction ?? 0) * 100).toFixed(1)}%` }}
                    />
                  </div>
                  <span className="w-40 truncate text-sm text-zinc-600 dark:text-zinc-300">
                    {mergeProgress?.phase === 'encode' ? 'Re-encoding…' : 'Copying streams…'}{' '}
                    {Math.floor((mergeProgress?.fraction ?? 0) * 100)}%
                  </span>
                </div>
                <button
                  onClick={cancelMerge}
                  className="h-11 rounded-full border border-zinc-300 px-6 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {/* Result ------------------------------------------------------- */}
      {result && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Merged result · {result.method === 'copy' ? 'lossless copy' : 're-encoded'}
          </h2>
          <div className="mt-2 overflow-hidden rounded-2xl border border-zinc-200 bg-black shadow-sm dark:border-zinc-700">
            {result.extension === 'mp4' ? (
              <video src={result.url} controls className="max-h-[60vh] w-full bg-black" />
            ) : (
              <audio src={result.url} controls className="w-full px-4 py-8" />
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
            <label className="flex min-w-0 min-w-[16rem] flex-1 items-center gap-2 text-zinc-500 dark:text-zinc-400">
              <span className="shrink-0">Name</span>
              <input
                value={resultName || result.fileName}
                onChange={(e) => setResultName(sanitizeFileInput(e.target.value))}
                onBlur={() => setResultName((v) => v.trim())}
                aria-label="Download file name"
                title="Rename before downloading — the file is saved under this name"
                className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm font-normal text-foreground outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-zinc-500 dark:text-zinc-400">
                {formatDuration(result.duration)} · {formatBytes(result.sizeBytes)}
              </span>
              <a
                href={result.url}
                download={withFileExtension(resultName.trim() || result.fileName, result.extension)}
                className="h-10 rounded-full bg-emerald-700 px-5 font-medium leading-10 text-white transition-colors hover:bg-emerald-800"
              >
                Download
              </a>
            </div>
          </div>
        </section>
      )}

      {lastClip && !result && (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Tip: add at least 2 clips to enable merging.
        </p>
      )}

      {/* Notices ------------------------------------------------------ */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {notices.map((n) => (
          <div
            key={n.id}
            role="alert"
            onClick={() => dismissNotice(n.id)}
            className={`pointer-events-auto max-w-xl cursor-pointer rounded-lg px-4 py-2 text-sm shadow-lg ${
              n.kind === 'error'
                ? 'bg-red-600 text-white'
                : n.kind === 'success'
                  ? 'bg-emerald-700 text-white'
                  : 'bg-zinc-800 text-white'
            }`}
          >
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Clip card                                                            */
/* -------------------------------------------------------------------- */

function ClipCard(props: {
  clip: ClipInfo;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onRemove: () => void;
  onDuplicate: () => void;
  onMove: (dir: 'up' | 'down') => void;
  onSetTrim: (trim: { start: number; end: number } | null) => void;
  onLocate: (file: File) => void;
}) {
  const { clip, isFirst, isLast, disabled, onRemove, onDuplicate, onMove, onSetTrim, onLocate } = props;
  // Either the trim editor or the plain preview player can be open at a time.
  const [panel, setPanel] = useState<'trim' | 'preview' | null>(null);
  const [editing, setEditing] = useState<{ start: number; end: number }>(clipTrim(clip));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const locateInputRef = useRef<HTMLInputElement>(null);
  const trimOpen = panel === 'trim';
  const isMissing = missingMedia(clip);

  const ensurePreviewUrl = () => {
    setPreviewUrl((url) => url ?? (clip.file ? URL.createObjectURL(clip.file) : null));
  };

  // Trim state is local while editing, committed on "Done".
  const openTrim = () => {
    setEditing(clipTrim(clip));
    ensurePreviewUrl();
    setPanel('trim');
  };
  const closeTrim = (commit: boolean) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    if (commit) onSetTrim({ start: editing.start, end: editing.end });
    setPanel(null);
  };
  const closePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPanel(null);
  };
  const togglePreview = () => {
    if (panel === 'preview') closePreview();
    else {
      ensurePreviewUrl();
      setPanel('preview');
    }
  };

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  const setFromPlayhead = (which: 'start' | 'end') => {
    const el = previewRef.current;
    if (!el) return;
    if (which === 'start') setEditing((e) => ({ ...e, start: clamp(el.currentTime, 0, e.end - 0.1) }));
    else setEditing((e) => ({ ...e, end: clamp(el.currentTime, e.start + 0.1, clip.duration) }));
  };

  const playTrim = () => {
    const el = previewRef.current;
    if (!el) return;
    el.currentTime = editing.start;
    void el.play();
  };

  const onPreviewTimeUpdate = () => {
    const el = previewRef.current;
    if (!el || el.paused) return;
    if (el.currentTime >= editing.end) el.pause();
  };

  // Shared inline player. The trim editor reuses it with playhead tracking
  // (stops at the trim end); a plain preview plays the file the same way.
  const playerEl = clip.type === 'video' ? (
    <video
      ref={(el) => {
        previewRef.current = el;
      }}
      src={previewUrl ?? undefined}
      controls
      onTimeUpdate={onPreviewTimeUpdate}
      className="max-h-60 w-full rounded bg-black"
    />
  ) : (
    <audio
      ref={(el) => {
        previewRef.current = el;
      }}
      src={previewUrl ?? undefined}
      controls
      onTimeUpdate={onPreviewTimeUpdate}
      className="w-full"
    />
  );

  const trimValid = editing.start >= 0 && editing.start < editing.end && editing.end <= clip.duration + 0.01;
  const isTrimmed = !!clip.trimStart || (clip.trimEnd !== null && clip.trimEnd !== clip.duration);

  return (
    <li
      className={`rounded-xl border bg-white p-2 pr-3 shadow-sm dark:bg-zinc-900/60 ${
        isMissing
          ? 'border-amber-400/70 dark:border-amber-500/50'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="flex w-7 flex-col items-center text-zinc-400" aria-hidden>
          <button
            onClick={() => onMove('up')}
            disabled={isFirst || disabled}
            className="text-xs text-zinc-500 hover:text-foreground disabled:opacity-25"
            aria-label={`Move ${clip.name} up`}
          >
            ▲
          </button>
          <button
            onClick={() => onMove('down')}
            disabled={isLast || disabled}
            className="text-xs text-zinc-500 hover:text-foreground disabled:opacity-25"
            aria-label={`Move ${clip.name} down`}
          >
            ▼
          </button>
        </span>

        {clip.thumbnailUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element -- blob URLs, no optimizer applies */
          <img src={clip.thumbnailUrl} alt="" className="h-12 w-20 rounded object-cover" />
        ) : (
          <div className="flex h-12 w-20 items-center justify-center rounded bg-zinc-100 text-xl dark:bg-zinc-800" aria-hidden>
            {clip.type === 'video' ? '🎬' : '🎵'}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground" title={clip.name}>
            {clip.name}
          </p>
          {isMissing ? (
            <p className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              ⚠ media missing — the file was moved or deleted since saving ({formatBytes(clip.sizeBytes)} expected)
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {isTrimmed ? (
                <>
                  <span className="font-medium text-blue-600 dark:text-blue-400">
                    {formatDuration(clippedSpan(clip))}
                  </span>
                  {' of '}
                </>
              ) : null}
              {formatDuration(clip.duration)} · {formatBytes(clip.sizeBytes)}
              {clip.video && ` · ${clip.video.codec.toUpperCase()} ${clip.video.displayWidth}×${clip.video.displayHeight}`}
              {clip.audio && ` · ${clip.audio.codec.toUpperCase()} ${clip.audio.sampleRate / 1000} kHz`}
              {((clip.video && !clip.video.canDecode) || (clip.audio && !clip.audio.canDecode)) && (
                <span title="This browser has no decoder for this track — merging will only work if a lossless copy is possible, otherwise re-encoding fails.">
                  {' '}
                  <span className="font-medium text-amber-700 dark:text-amber-400">
                    · ⚠ no decoder in this browser
                  </span>
                </span>
              )}
            </p>
          )}
        </div>

        {isMissing && (
          <button
            onClick={() => locateInputRef.current?.click()}
            disabled={disabled}
            title="Choose the clip's media file again (matched by name)"
            className="shrink-0 rounded-lg px-2 py-1 text-sm font-medium text-amber-700 hover:text-amber-800 disabled:opacity-30 dark:text-amber-400 dark:hover:text-amber-300"
          >
            ⤒ locate
          </button>
        )}

        <button
          onClick={togglePreview}
          disabled={disabled || trimOpen || isMissing}
          className="rounded-lg px-2 py-1 text-sm text-zinc-600 hover:text-blue-700 disabled:opacity-30 dark:text-zinc-400 dark:hover:text-blue-400"
          aria-label={panel === 'preview' ? `Close ${clip.name} preview` : `Preview ${clip.name}`}
          title={isMissing ? 'Relink the media first' : panel === 'preview' ? 'Close preview' : 'Preview'}
        >
          {panel === 'preview' ? '⏸' : '▶'}
        </button>

        <button
          onClick={() => (trimOpen ? closeTrim(false) : openTrim())}
          disabled={disabled || isMissing}
          title={isMissing ? 'Relink the media first' : undefined}
          className={`rounded-lg px-2 py-1 text-sm ${
            isTrimmed ? 'font-medium text-blue-700 dark:text-blue-400' : 'text-zinc-600 hover:text-foreground dark:text-zinc-400'
          } disabled:opacity-30`}
        >
          ✂ trim
        </button>

        <button
          onClick={onDuplicate}
          disabled={disabled || isMissing}
          title={isMissing ? 'Relink the media first' : 'Copy this clip with its trim, directly below it'}
          className="rounded-lg px-2 py-1 text-sm text-zinc-600 hover:text-blue-700 disabled:opacity-30 dark:text-zinc-400 dark:hover:text-blue-400"
        >
          ⧉ duplicate
        </button>

        <input
          ref={locateInputRef}
          type="file"
          accept="video/*,audio/*"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (picked) onLocate(picked);
          }}
        />

        <button
          onClick={onRemove}
          disabled={disabled}
          className="rounded-lg px-2 py-1 text-sm text-zinc-600 hover:text-red-700 disabled:opacity-30 dark:text-zinc-400 dark:hover:text-red-400"
          aria-label={`Remove ${clip.name}`}
        >
          ✕
        </button>
      </div>

      {panel === 'preview' && (
        <div className="mt-3">
          {playerEl}
        </div>
      )}

      {trimOpen && (
        <div className="mt-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
          {/* Preview ------------------------------------------------- */}
          {playerEl}

          {/* Sliders -------------------------------------------------- */}
          <div className="mt-3 space-y-2">
            <TrimSlider
              label="Start"
              value={editing.start}
              min={0}
              max={Math.max(0, editing.end - 0.1)}
              onChange={(v) => setEditing((e) => ({ ...e, start: v }))}
              disabled={disabled}
            />
            <TrimSlider
              label="End"
              value={editing.end}
              min={Math.min(clip.duration, editing.start + 0.1)}
              max={clip.duration}
              onChange={(v) => setEditing((e) => ({ ...e, end: v }))}
              disabled={disabled}
            />
          </div>

          {/* Actions -------------------------------------------------- */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <button
              onClick={playTrim}
              disabled={disabled || !trimValid}
              className="h-8 rounded-full bg-blue-700 px-4 font-medium text-white hover:bg-blue-600 disabled:opacity-40 dark:bg-blue-600 dark:hover:bg-blue-700"
            >
              ▶ Preview trim
            </button>
            <button
              onClick={() => setFromPlayhead('start')}
              disabled={disabled}
              className="h-8 rounded-full border border-zinc-300 px-3 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 disabled:opacity-40"
            >
              Start ⇐ playhead
            </button>
            <button
              onClick={() => setFromPlayhead('end')}
              disabled={disabled}
              className="h-8 rounded-full border border-zinc-300 px-3 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 disabled:opacity-40"
            >
              End ⇐ playhead
            </button>
            <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
              kept: {trimValid ? formatDuration(editing.end - editing.start) : 'invalid'}
            </span>
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            {!trimValid && (
              <span className="mr-auto text-xs text-red-700 dark:text-red-400">Start must be before End, both inside the file.</span>
            )}
            {isTrimmed && (
              <button
                onClick={() => setEditing({ start: 0, end: clip.duration })}
                disabled={disabled}
                className="h-8 rounded-full px-3 text-zinc-500 hover:text-foreground disabled:opacity-40"
              >
                Reset
              </button>
            )}
            <button
              onClick={() => closeTrim(false)}
              disabled={disabled}
              className="h-8 rounded-full px-3 text-zinc-500 hover:text-foreground disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={() => closeTrim(true)}
              disabled={disabled || !trimValid}
              className="h-8 rounded-full bg-slate-800 px-4 font-medium text-white hover:bg-slate-700 dark:bg-zinc-700 dark:hover:bg-zinc-600 disabled:opacity-40"
            >
              Done
            </button>
          </div>
          <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            Lossless merges must start cuts on a keyframe (usually every 1–3 s); cuts farther off fall back to a
            re-encode so frames land exactly where you placed them.
          </p>
        </div>
      )}
    </li>
  );
}

/** Slider plus a typed seconds field, so exact crossfade lengths can be entered. */
function CrossfadeLengthControl(props: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const { value, disabled, onChange } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const skipCommit = useRef(false);

  const commit = () => {
    if (skipCommit.current) {
      skipCommit.current = false;
      return;
    }
    if (draft === null) return;
    const parsed = parseSecondsInput(draft);
    setDraft(null);
    if (parsed === null) return;
    onChange(parsed);
  };

  return (
    <label className="flex items-center gap-2">
      <span className="text-zinc-500 dark:text-zinc-400">Length</span>
      <input
        type="range"
        min={MIN_CROSSFADE_SECONDS}
        max={MAX_CROSSFADE_SECONDS}
        step={0.01}
        value={value}
        disabled={disabled}
        aria-label="Crossfade duration"
        onChange={(e) => {
          setDraft(null);
          onChange(Number(e.target.value));
        }}
        className="w-32 accent-blue-600"
      />
      <input
        type="text"
        value={draft ?? value.toFixed(2)}
        disabled={disabled}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        title="Type seconds (0.01–2), then press Enter"
        aria-label="Crossfade duration value"
        className="w-16 rounded border border-zinc-300 bg-white px-1 py-0.5 text-right font-mono text-xs text-foreground disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-800"
        onChange={(e) => {
          skipCommit.current = false;
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            skipCommit.current = true;
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">s</span>
    </label>
  );
}

function TrimSlider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const { label, value, min, max, disabled, onChange } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const skipCommit = useRef(false);
  const shown = draft ?? formatTimecode(value);

  const commit = () => {
    if (skipCommit.current) {
      skipCommit.current = false;
      return;
    }
    if (draft === null) return;
    const parsed = parseTimecode(draft);
    setDraft(null);
    if (parsed === null) return;
    onChange(Math.min(max, Math.max(min, parsed)));
  };

  return (
    <div className="flex items-center gap-2">
      <label className="w-10 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-blue-600"
        aria-label={`Trim ${label.toLowerCase()}`}
      />
      <input
        type="text"
        value={shown}
        disabled={disabled}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        title="Type a time as MM:SS.hh, then press Enter"
        aria-label={`Trim ${label.toLowerCase()} time`}
        className="w-20 rounded border border-zinc-300 bg-white px-1 py-0.5 text-right font-mono text-xs text-foreground disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-800"
        onChange={(e) => {
          skipCommit.current = false;
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            skipCommit.current = true;
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
