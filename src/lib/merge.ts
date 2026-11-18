/**
 * The client-side merge engine. Joins any number of same-type clips
 * (all videos or all audios) into one file, fully in the browser.
 *
 * Two strategies:
 *  - 'copy'   — every clip shares compatible codecs/parameters: encoded packets
 *               are re-timestamped and copied byte-for-byte (lossless, fast).
 *  - 'encode' — mixed sources: everything is decoded and re-encoded once into
 *               a common format (H.264/AAC MP4 for videos, AAC MP4 for audio)
 *               with hardware acceleration via WebCodecs.
 */
import type { InputAudioTrack, InputVideoTrack, VideoSample } from 'mediabunny';
import type { ClipInfo, JobType, MergeOutput, MergeResult } from './model';
import { clipTrim } from './model';
import { openFile } from './probe';
import { buildTimeline, type Timeline } from './timeline';
import { AUDIO_CHANNELS, AUDIO_RATE, encodeMp3, renderTimelineAudio, type AudioTimelineSegment } from './audio';

/**
 * How far a lossless copy-join may miss the requested trim start, in seconds.
 * Copy-joins always start at a keyframe at-or-after the requested start
 * (mirroring mediabunny's own Conversion); if a clip's nearest keyframe is
 * further away than this, the whole job takes the precise re-encode path.
 */
const COPY_BOUNDARY_TOLERANCE = 2;

export interface MergeOptions {
  jobType: JobType;
  signal?: AbortSignal;
  onProgress?: (info: { phase: 'copy' | 'encode'; fraction: number }) => void;
  /** Seconds of overlap at each join. Video jobs only; 0 disables crossfades. */
  crossfadeSeconds?: number;
  /** 'audio-mp3' extracts the soundtrack of a video job as an MP3 file. */
  outputFormat?: MergeOutput;
}

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeError';
  }
}

export class MergeCanceledError extends Error {
  constructor() {
    super('Merge canceled.');
    this.name = 'MergeCanceledError';
  }
}

interface OpenedClip {
  clip: ClipInfo;
  videoTrack: InputVideoTrack | null;
  audioTrack: InputAudioTrack | null;
}

let mb: typeof import('mediabunny') | null = null;
async function lib(): Promise<typeof import('mediabunny')> {
  return (mb ??= await import('mediabunny'));
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MergeCanceledError();
}

function makeProgress(
  onProgress: MergeOptions['onProgress'],
  phase: 'copy' | 'encode',
  signal?: AbortSignal,
): (fraction: number) => void {
  return (fraction: number) => {
    checkAborted(signal);
    onProgress?.({ phase, fraction: Math.max(0, Math.min(1, fraction)) });
  };
}

/** Opens each clip and finds its primary tracks once, upfront. */
async function openClips(clips: ClipInfo[]): Promise<OpenedClip[]> {
  // mergeClips rejects missing media before this runs; the `!` is safe here.
  const inputs = await Promise.all(clips.map((clip) => openFile(clip.file!)));
  return Promise.all(
    inputs.map(async (input, i) => ({
      clip: clips[i]!,
      videoTrack: (await input.getPrimaryVideoTrack()) ?? null,
      audioTrack: (await input.getPrimaryAudioTrack()) ?? null,
    })),
  );
}

/**
 * Packet-accurate span of one clip on the merged timeline: how long the
 * longest of its tracks really is, cropped to the clip's trim window.
 */
async function clipSpanOf(clip: OpenedClip, trimStart = 0, trimEnd = clip.clip.duration): Promise<number> {
  let span: number;
  if (!clip.videoTrack && !clip.audioTrack) {
    span = clip.clip.duration;
  } else {
    const [videoDuration, audioDuration] = await Promise.all([
      clip.videoTrack?.computeDuration() ?? 0,
      clip.audioTrack?.computeDuration() ?? 0,
    ]);
    span = Math.max(videoDuration, audioDuration) || clip.clip.duration;
  }
  const start = Math.min(Math.max(0, trimStart), span);
  const end = Math.min(Math.max(trimStart, trimEnd), span);
  return Math.max(0, end - start);
}

/** Audio segments are just the timeline plus each clip's trim window. */
function audioSegments(
  opened: OpenedClip[],
  trims: { start: number; end: number }[],
  spans: number[],
  timeline: Timeline,
): AudioTimelineSegment[] {
  return opened.map((clip, i) => ({
    track: clip.audioTrack,
    trimStart: trims[i]!.start,
    trimEnd: trims[i]!.end,
    start: timeline.starts[i]!,
    span: spans[i]!,
    fadeIn: timeline.fadesIn[i]!,
    fadeOut: timeline.fadesOut[i]!,
  }));
}

/* ------------------------------------------------------------------ */
/* Method selection                                                    */
/* ------------------------------------------------------------------ */

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if ((a === undefined) !== (b === undefined)) return false;
  if (!a) return true;
  if (a.length !== b!.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b![i]) return false;
  return true;
}

function sameRational(a: { num: number; den: number }, b: { num: number; den: number }): boolean {
  return a.num === b.num && a.den === b.den;
}

/**
 * Evaluates a copied track's trim boundaries, mirroring mediabunny's
 * Conversion 'shrink' policy: the copy starts at the first keyframe at-or
 * after the requested start (earlier packets would produce broken decoder
 * state); deviation beyond the tolerance can't be copied losslessly.
 */
async function trimIsCopyable(track: InputVideoTrack | InputAudioTrack, clip: ClipInfo): Promise<boolean> {
  const m = await lib();
  const { EncodedPacketSink } = m;
  const { start: trimStart } = clipTrim(clip);
  if (trimStart === 0) return true;

  const sink = new EncodedPacketSink(track);
  let startPacket = await sink.getKeyPacket(trimStart, { verifyKeyPackets: true });
  if (startPacket && startPacket.timestamp < trimStart) {
    // Jump to the next keyframe, shrinking the lead below the requested start.
    startPacket = await sink.getNextKeyPacket(startPacket, { verifyKeyPackets: true });
  }
  if (!startPacket) return false;
  return startPacket.timestamp - trimStart <= COPY_BOUNDARY_TOLERANCE;
}

/**
 * Decides whether a lossless copy-join is possible for all clips:
 * same video codec + same dimensions/rotation/flip + identical decoder
 * descriptions, and (for the clips that carry audio) same audio parameters.
 */
async function canCopyJoin(opened: OpenedClip[], jobType: JobType): Promise<boolean> {
  if (jobType === 'video') {
    for (const o of opened) {
      if (!(await trimIsCopyable(o.videoTrack!, o.clip))) return false;
    }
    const first = opened[0].videoTrack!;
    const [firstCodec, firstW, firstH, firstRot, firstFlip, firstPar, firstConfig] = await Promise.all([
      first.getCodec(),
      first.getDisplayWidth(),
      first.getDisplayHeight(),
      first.getRotation(),
      first.getFlip(),
      first.getPixelAspectRatio(),
      first.getDecoderConfig(),
    ]);
    if (!firstCodec || !firstConfig) return false;

    for (const track of opened.slice(1).map((o) => o.videoTrack!)) {
      const [codec, w, h, rot, flip, par, config] = await Promise.all([
        track.getCodec(),
        track.getDisplayWidth(),
        track.getDisplayHeight(),
        track.getRotation(),
        track.getFlip(),
        track.getPixelAspectRatio(),
        track.getDecoderConfig(),
      ]);
      if (codec !== firstCodec || !config) return false;
      if (w !== firstW || h !== firstH || rot !== firstRot || flip !== firstFlip) return false;
      if (!sameRational(par, firstPar)) return false;
      if (!bytesEqual(config.description as Uint8Array | undefined, firstConfig.description as Uint8Array | undefined)) {
        return false;
      }
    }
  }

  // All clips that carry audio must share codec, rate, channel count and
  // decoder description; clips without audio simply have silent spans.
  const audios = opened.map((o) => o.audioTrack).filter((t): t is InputAudioTrack => t !== null);
  if (audios.length > 0) {
    for (const o of opened) {
      if (o.audioTrack && !(await trimIsCopyable(o.audioTrack, o.clip))) return false;
    }
    const first = audios[0];
    const [firstCodec, firstRate, firstCh, firstConfig] = await Promise.all([
      first.getCodec(),
      first.getSampleRate(),
      first.getNumberOfChannels(),
      first.getDecoderConfig(),
    ]);
    if (!firstCodec || !firstConfig) return false;

    for (const track of audios.slice(1)) {
      const [codec, rate, ch, config] = await Promise.all([
        track.getCodec(),
        track.getSampleRate(),
        track.getNumberOfChannels(),
        track.getDecoderConfig(),
      ]);
      if (codec !== firstCodec || rate !== firstRate || ch !== firstCh || !config) return false;
      if (!bytesEqual(config.description as Uint8Array | undefined, firstConfig.description as Uint8Array | undefined)) {
        return false;
      }
    }
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* Encode-path decodability guard                                      */
/* ------------------------------------------------------------------ */

const CODEC_LABELS: Record<string, string> = {
  avc: 'H.264 (AVC)',
  hevc: 'H.265 (HEVC)',
  vp9: 'VP9',
  av1: 'AV1',
  vp8: 'VP8',
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  flac: 'FLAC',
  vorbis: 'Vorbis',
};

function codecLabel(codec: string): string {
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}

/**
 * Re-encoding requires WebCodecs to decode every participating track. A
 * track the browser can't decode would otherwise fail mid-merge with
 * mediabunny's raw sink error ("cannot be decoded in this environment"),
 * so reject copiously before any processing work.
 */
async function assertTracksDecodable(opened: OpenedClip[], jobType: JobType): Promise<void> {
  const missingDecoder = async (track: InputVideoTrack | InputAudioTrack): Promise<string | null> =>
    (await track.canDecode()) ? null : codecLabel((await track.getCodec()) ?? 'unknown');

  for (const o of opened) {
    if (jobType === 'video' && o.videoTrack) {
      const label = await missingDecoder(o.videoTrack);
      if (label) {
        throw new MergeError(
          `"${o.clip.name}" is ${label} video, which this browser can't decode — and because a lossless copy was not possible, the clips must be re-encoded. Convert the file to H.264 MP4 first, then merge again.`,
        );
      }
    }
    if (o.audioTrack) {
      const label = await missingDecoder(o.audioTrack);
      if (label) {
        throw new MergeError(
          `"${o.clip.name}" has ${label} audio, which this browser can't decode — and because a lossless copy was not possible, the clips must be re-encoded. Convert the file to AAC MP4 first, then merge again.`,
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Strategy 1: lossless copy join                                      */
/* ------------------------------------------------------------------ */

async function copyJoin(
  opened: OpenedClip[],
  options: MergeOptions,
  totalDuration: number,
): Promise<Blob> {
  const m = await lib();
  const {
    Output,
    Mp4OutputFormat,
    BufferTarget,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    EncodedAudioPacketSource,
  } = m;
  const { onProgress, signal } = options;
  const reportProgress = makeProgress(onProgress, 'copy', signal);

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  // Every clip shares the same codec & configuration (verified in
  // canCopyJoin), so each clip's own decoder config travels with its packets.
  const isVideoJob = options.jobType === 'video';
  const videoSource = isVideoJob
    ? new EncodedVideoPacketSource((await opened[0]!.videoTrack!.getCodec())!)
    : null;
  if (videoSource) output.addVideoTrack(videoSource);

  const clipsWithAudio = opened.filter((o) => o.audioTrack !== null);
  const audioSource = clipsWithAudio.length
    ? new EncodedAudioPacketSource((await clipsWithAudio[0]!.audioTrack!.getCodec())!)
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  await output.start();

  // Where the current clip sits on the output timeline.
  let mediaTime = 0;
  let videoSeq = 0;
  let audioSeq = 0;

  /**
   * Copies one track's packets for one clip, honoring its trim window.
   * Mirrors mediabunny's own Conversion copy pumps (shrink policy): video
   * packets are clamped into the trim window (key packets demoted to delta
   * when they would regress), audio packets are dropped on regression and
   * the tail never spills past the end. Returns the track's next sequence
   * number plus the output-timeline position just past the last copied
   * packet, so the caller advances the timeline by what was emitted.
   */
  const copyTrack = async (
    kind: 'video' | 'audio',
    track: InputVideoTrack | InputAudioTrack,
    source: import('mediabunny').EncodedVideoPacketSource | import('mediabunny').EncodedAudioPacketSource,
    clip: ClipInfo,
    baseTime: number,
    sequenceStart: number,
  ): Promise<{ sequence: number; end: number }> => {
    const sink = new EncodedPacketSink(track);
    const { start: trimStart, end: trimEnd } = clipTrim(clip);

    // 'shrink' boundary, mirroring mediabunny's own Conversion: copy starts
    // at the first keyframe at-or-after trimStart (earlier packets would
    // decode from broken state). canCopyJoin already ensured the distance
    // from trimStart to that keyframe is within the copy tolerance.
    let startPacket = await sink.getKeyPacket(trimStart, { verifyKeyPackets: true })
      ?? await sink.getFirstKeyPacket({ verifyKeyPackets: true });
    if (startPacket && startPacket.timestamp < trimStart) {
      startPacket = await sink.getNextKeyPacket(startPacket, { verifyKeyPackets: true });
    }
    if (!startPacket) throw new MergeError(`No packets available in "${clip.name}".`);

    const offset = baseTime - startPacket.timestamp;
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) throw new MergeError(`"${clip.name}" has an unknown codec.`);
    const meta = { decoderConfig };
    // Largest output timestamp accepted so far; key packets must never
    // regress below it (the muxer enforces this per GOP).
    let maxTimestamp: number | null = null;
    let end = baseTime;
    let sequence = sequenceStart;

    // Widening-cast: the concrete source (video or audio packet source)
    // accepts exactly this metadata shape at runtime.
    const addPacket = source.add.bind(source) as (
      p: import('mediabunny').EncodedPacket,
      m?: { decoderConfig: unknown },
    ) => Promise<void>;

    for await (
      const packet of kind === 'video'
        ? sink.packets(startPacket, undefined, { verifyKeyPackets: true })
        : sink.packets(startPacket)
    ) {
      checkAborted(signal);
      if (packet.timestamp >= trimEnd) break;
      // Audio shrinks strictly: a packet spilling past the end is dropped,
      // while video packets are clamped into the window (see below).
      if (kind === 'audio' && packet.timestamp + packet.duration > trimEnd) break;

      // Shrink policy: clamp the copied packet into the trim window.
      const inStart = Math.max(packet.timestamp, trimStart);
      const inEnd = Math.min(packet.timestamp + packet.duration, trimEnd);
      const shiftedStart = inStart + offset;
      const shiftedDuration = Math.max(inEnd - inStart, 0);

      const maxOut = maxTimestamp ?? -Infinity;
      if (kind === 'audio') {
        // Drop packets that would violate the GOP timestamp monotonicity rule.
        if (shiftedStart < maxOut) continue;
      }
      maxTimestamp = Math.max(maxOut, shiftedStart);

      end = shiftedStart + shiftedDuration;
      await addPacket(
        kind === 'video'
          ? // The muxer rejects key packets regressing below the previous
            // GOP's largest timestamp; demote them to delta packets to keep
            // the packet (and the rule) satisfied.
            packet.clone({
              timestamp: shiftedStart,
              duration: shiftedDuration,
              sequenceNumber: sequence++,
              type: packet.type === 'key' && shiftedStart < maxOut ? 'delta' : packet.type,
              sideData: packet.sideData,
            })
          : packet.clone({ timestamp: shiftedStart, duration: shiftedDuration, sequenceNumber: sequence++ }),
        meta,
      );
    }
    return { sequence, end };
  };

  try {
    for (const openedClip of opened) {
      checkAborted(signal);

      let clipEnd = mediaTime;
      if (videoSource && openedClip.videoTrack) {
        const result = await copyTrack('video', openedClip.videoTrack, videoSource, openedClip.clip, mediaTime, videoSeq);
        videoSeq = result.sequence;
        clipEnd = Math.max(clipEnd, result.end);
      }
      if (audioSource && openedClip.audioTrack) {
        const result = await copyTrack('audio', openedClip.audioTrack, audioSource, openedClip.clip, mediaTime, audioSeq);
        audioSeq = result.sequence;
        clipEnd = Math.max(clipEnd, result.end);
      }

      mediaTime = clipEnd;
      reportProgress(mediaTime / totalDuration);
    }

    videoSource?.close();
    audioSource?.close();
    await output.finalize();
  } catch (err) {
    try {
      if (output.state === 'started') await output.cancel();
    } catch {
      /* best effort */
    }
    throw err;
  }

  const buffer = output.target.buffer;
  if (!buffer) throw new MergeError('Merging produced no data.');
  return new Blob([buffer], { type: options.jobType === 'video' ? 'video/mp4' : 'audio/mp4' });
}

/* ------------------------------------------------------------------ */
/* Strategy 2: decode + re-encode                                      */
/* ------------------------------------------------------------------ */

function clipsWithAudioCount(opened: OpenedClip[]): number {
  return opened.filter((o) => o.audioTrack !== null).length;
}

async function encodeJoin(
  opened: OpenedClip[],
  options: MergeOptions,
  totalDuration: number,
): Promise<Blob> {
  const m = await lib();
  const {
    Output,
    Mp4OutputFormat,
    BufferTarget,
    VideoSampleSource,
    AudioSampleSource,
    VideoSampleSink,
    AudioSampleSink,
    VideoSample,
    Quality,
    getFirstEncodableVideoCodec,
    getFirstEncodableAudioCodec,
  } = m;
  const { onProgress, signal, jobType } = options;
  const reportProgress = makeProgress(onProgress, 'encode', signal);

  const isVideoJob = jobType === 'video';
  const firstVideo = opened.find((o) => o.videoTrack);
  let targetWidth = 0;
  let targetHeight = 0;
  let videoCodec: import('mediabunny').VideoCodec | null = null;
  if (isVideoJob) {
    const rawW = await firstVideo!.videoTrack!.getDisplayWidth();
    const rawH = await firstVideo!.videoTrack!.getDisplayHeight();

    // Cap the long edge at 1920 px; keep even dimensions (encoders prefer that).
    const scale = Math.min(1, 1920 / Math.max(rawW, rawH));
    targetWidth = Math.max(2, Math.floor((rawW * scale) / 2) * 2);
    targetHeight = Math.max(2, Math.floor((rawH * scale) / 2) * 2);

    videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'], {
      width: targetWidth,
      height: targetHeight,
    });
    if (!videoCodec) {
      throw new MergeError('This browser cannot encode video to any common codec (H.264, VP9, AV1, VP8).');
    }
  }

  const firstAudio = opened.find((o) => o.audioTrack);
  const audioCandidates = jobType === 'audio' ? (['aac', 'opus', 'flac'] as const) : (['aac', 'opus'] as const);
  const audioCodec =
    firstAudio && clipsWithAudioCount(opened) > 0 ? await getFirstEncodableAudioCodec([...audioCandidates]) : null;
  if (clipsWithAudioCount(opened) > 0 && !audioCodec) {
    throw new MergeError('This browser cannot encode audio to any common codec (AAC, Opus, FLAC).');
  }

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const videoSource = videoCodec
    ? new VideoSampleSource({
        codec: videoCodec,
        quality: new Quality('high'),
        // Clips that differ in size are letterboxed ("contained") around the
        // dimensions of the first encoded frame instead of failing the merge.
        sizeChangeBehavior: 'contain',
      })
    : null;
  if (videoSource) output.addVideoTrack(videoSource);

  let audioSource: import('mediabunny').AudioSampleSource | null = null;
  if (audioCodec && firstAudio) {
    const [targetRate, targetChannels] = await Promise.all([
      firstAudio.audioTrack!.getSampleRate(),
      firstAudio.audioTrack!.getNumberOfChannels(),
    ]);
    audioSource = new AudioSampleSource({
      codec: audioCodec,
      quality: new Quality('high'),
      // mediabunny resamples and up/downmixes mixed sources automatically.
      transform: { sampleRate: targetRate, numberOfChannels: targetChannels },
    });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  let mediaTime = 0;
  try {
    for (const openedClip of opened) {
      checkAborted(signal);

      const { start: trimStart, end: trimEnd } = clipTrim(openedClip.clip);

      if (videoSource && openedClip.videoTrack) {
        const sink = new VideoSampleSink(openedClip.videoTrack);
        const offset = mediaTime - trimStart;

        // The sink decodes from the keyframe preceding trimStart and yields
        // only samples inside [trimStart, trimEnd) — frame-accurate trims.
        for await (const sample of sink.samples(trimStart, trimEnd)) {
          checkAborted(signal);
          // toVideoFrame() deep-copies the frame data, so the original sample
          // can be released right away. Rotation/flip are carried along so
          // the muxer stores (or bakes) them correctly.
          const frame = sample.toVideoFrame();
          const shifted = new VideoSample(frame, {
            timestamp: sample.timestamp + offset,
            duration: sample.duration,
            rotation: sample.rotation,
            flip: sample.flip,
          });
          sample.close();
          await videoSource.add(shifted);
          shifted.close();
        }
      }

      if (audioSource && openedClip.audioTrack) {
        const sink = new AudioSampleSink(openedClip.audioTrack);
        const offset = mediaTime - trimStart;

        for await (const sample of sink.samples(trimStart, trimEnd)) {
          checkAborted(signal);
          sample.setTimestamp(sample.timestamp + offset);
          await audioSource.add(sample);
          sample.close();
        }
      }

      mediaTime += await clipSpanOf(openedClip, trimStart, trimEnd);
      reportProgress(mediaTime / totalDuration);
    }

    videoSource?.close();
    audioSource?.close();
    await output.finalize();
  } catch (err) {
    try {
      if (output.state === 'started') await output.cancel();
    } catch {
      /* best effort */
    }
    throw err;
  }

  const buffer = output.target.buffer;
  if (!buffer) throw new MergeError('Merging produced no data.');
  return new Blob([buffer], { type: jobType === 'video' ? 'video/mp4' : 'audio/mp4' });
}

/* ------------------------------------------------------------------ */
/* Crossfade join (video + audio)                                      */
/* ------------------------------------------------------------------ */

interface TimedVideoFrame {
  time: number;
  sample: VideoSample;
}

/** Decodes one clip's trimmed frames, rebased onto the output timeline. */
async function* trimmedVideoFrames(
  clip: OpenedClip,
  trimStart: number,
  trimEnd: number,
  outputStart: number,
  signal?: AbortSignal,
): AsyncGenerator<TimedVideoFrame> {
  const { VideoSampleSink } = await lib();
  const sink = new VideoSampleSink(clip.videoTrack!);
  for await (const sample of sink.samples(trimStart, trimEnd)) {
    checkAborted(signal);
    yield { time: sample.timestamp + outputStart - trimStart, sample };
  }
}

function drawVideoFrame(
  context: CanvasRenderingContext2D,
  frame: VideoFrame,
  sample: VideoSample,
  width: number,
  height: number,
): void {
  const scale = Math.min(width / Math.max(1, sample.displayWidth), height / Math.max(1, sample.displayHeight));
  context.save();
  context.translate(width / 2, height / 2);
  context.scale(scale, scale);
  if (sample.rotation) context.rotate((sample.rotation * Math.PI) / 180);
  if (sample.flip) context.scale(-1, 1);
  context.drawImage(frame, -sample.codedWidth / 2, -sample.codedHeight / 2);
  context.restore();
}

/** Linear fade at each edge of a clip; zero outside its window. */
function crossfadeWeight(
  index: number,
  time: number,
  starts: number[],
  spans: number[],
  fadesIn: number[],
  fadesOut: number[],
): number {
  const start = starts[index]!;
  const end = start + spans[index]!;
  if (time < start || time >= end) return 0;
  let weight = 1;
  if (fadesIn[index]! > 0 && time < start + fadesIn[index]!) {
    weight *= (time - start) / fadesIn[index]!;
  }
  if (fadesOut[index]! > 0 && time > end - fadesOut[index]!) {
    weight *= (end - time) / fadesOut[index]!;
  }
  return Math.max(0, Math.min(1, weight));
}

/**
 * Re-encodes the whole job with overlapping clips: during each overlap the
 * outgoing frame dissolves into the incoming one on a canvas while their
 * sound is mixed with matching gain ramps.
 */
async function crossfadeJoin(
  opened: OpenedClip[],
  options: MergeOptions,
  spans: number[],
  timeline: Timeline,
): Promise<Blob> {
  const m = await lib();
  const {
    Output,
    Mp4OutputFormat,
    BufferTarget,
    VideoSampleSource,
    VideoSample,
    Quality,
    AudioBufferSource,
    getFirstEncodableVideoCodec,
    getFirstEncodableAudioCodec,
  } = m;
  const { signal, onProgress } = options;
  const reportProgress = makeProgress(onProgress, 'encode', signal);

  const firstVideo = opened.find((o) => o.videoTrack)!;
  const [rawW, rawH] = await Promise.all([
    firstVideo.videoTrack!.getDisplayWidth(),
    firstVideo.videoTrack!.getDisplayHeight(),
  ]);
  const scale = Math.min(1, 1920 / Math.max(rawW, rawH));
  const width = Math.max(2, Math.floor((rawW * scale) / 2) * 2);
  const height = Math.max(2, Math.floor((rawH * scale) / 2) * 2);

  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'], { width, height });
  if (!videoCodec) {
    throw new MergeError('This browser cannot encode video to any common codec (H.264, VP9, AV1, VP8).');
  }
  const hasAudio = opened.some((o) => o.audioTrack);
  const audioCodec = hasAudio ? await getFirstEncodableAudioCodec(['aac', 'opus']) : null;
  if (hasAudio && !audioCodec) {
    throw new MergeError('This browser cannot encode audio to AAC or Opus.');
  }

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const videoSource = new VideoSampleSource({
    codec: videoCodec,
    quality: new Quality('high'),
    sizeChangeBehavior: 'contain',
  });
  output.addVideoTrack(videoSource);
  const audioSource = audioCodec
    ? new AudioBufferSource({
        codec: audioCodec,
        quality: new Quality('high'),
        transform: { sampleRate: AUDIO_RATE, numberOfChannels: AUDIO_CHANNELS },
      })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new MergeError('This browser cannot create a 2D canvas for video crossfades.');

  await output.start();
  const trims = opened.map((o) => clipTrim(o.clip));
  const streams = opened.map((clip, i) =>
    clip.videoTrack
      ? trimmedVideoFrames(clip, trims[i]!.start, trims[i]!.end, timeline.starts[i]!, signal)
      : null,
  );
  const heads: (TimedVideoFrame | null)[] = new Array(opened.length).fill(null);
  const active: (TimedVideoFrame | null)[] = new Array(opened.length).fill(null);
  const decoded: ({ sample: VideoSample; frame: VideoFrame } | null)[] = new Array(opened.length).fill(null);

  try {
    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i];
      if (!stream) continue;
      const first = await stream.next();
      heads[i] = first.done || !first.value ? null : first.value;
    }

    while (heads.some(Boolean)) {
      checkAborted(signal);
      let primaryIndex = -1;
      let nextTime = Number.POSITIVE_INFINITY;
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i];
        if (head && head.time < nextTime) {
          nextTime = head.time;
          primaryIndex = i;
        }
      }
      if (primaryIndex === -1) break;

      // Move every frame due at this instant into the active set. Frames from
      // the previous instant are held so differing frame rates can overlap.
      for (let i = 0; i < streams.length; i++) {
        const head = heads[i];
        if (!head || head.time > nextTime + 1e-4) continue;
        if (active[i]?.sample !== head.sample) {
          decoded[i]?.frame.close();
          decoded[i] = { sample: head.sample, frame: head.sample.toVideoFrame() };
        }
        active[i] = head;
        const next = await streams[i]!.next();
        heads[i] = next.done || !next.value ? null : next.value;
      }

      const weights = new Array<number>(opened.length).fill(0);
      let totalWeight = 0;
      for (let i = 0; i < active.length; i++) {
        if (!active[i]) continue;
        weights[i] = crossfadeWeight(
          i,
          nextTime,
          timeline.starts,
          spans,
          timeline.fadesIn,
          timeline.fadesOut,
        );
        totalWeight += weights[i]!;
      }

      // Drop frames from clips whose window has passed so they don't linger.
      for (let i = 0; i < active.length; i++) {
        if (active[i] && weights[i] === 0) {
          decoded[i]?.frame.close();
          decoded[i] = null;
          active[i] = null;
        }
      }
      if (totalWeight <= 0) continue;

      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      context.fillStyle = '#000';
      context.fillRect(0, 0, width, height);
      // Additive blending of normalized weights gives a true weighted average.
      context.globalCompositeOperation = 'lighter';
      for (let i = 0; i < active.length; i++) {
        if (weights[i]! <= 0) continue;
        const entry = decoded[i]!;
        context.globalAlpha = weights[i]! / totalWeight;
        drawVideoFrame(context, entry.frame, entry.sample, width, height);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';

      // The frame that triggered this instant can have zero weight (the very
      // first frame of a fade-in), in which case it was just retired above.
      const primary = decoded[primaryIndex] ?? decoded.find(Boolean);
      const duration = Math.max(1 / 30, primary?.sample.duration || 0);
      const merged = new VideoSample(canvas, { timestamp: nextTime, duration });
      await videoSource.add(merged);
      merged.close();
      reportProgress(nextTime / Math.max(timeline.total, 1e-6));
    }

    videoSource.close();
    if (audioSource) {
      const buffer = await renderTimelineAudio(audioSegments(opened, trims, spans, timeline), timeline.total, signal);
      await audioSource.add(buffer);
      audioSource.close();
    }
    await output.finalize();
  } catch (err) {
    try {
      if (output.state === 'started') await output.cancel();
    } catch {
      /* best effort */
    }
    throw err;
  } finally {
    for (const entry of decoded) entry?.frame.close();
    for (const stream of streams) {
      if (!stream) continue;
      try {
        await stream.return(undefined);
      } catch {
        /* best effort */
      }
    }
  }

  const buffer = output.target.buffer;
  if (!buffer) throw new MergeError('Merging produced no data.');
  return new Blob([buffer], { type: 'video/mp4' });
}

/* ------------------------------------------------------------------ */
/* Audio-only MP3 export                                               */
/* ------------------------------------------------------------------ */

async function mp3Join(
  opened: OpenedClip[],
  options: MergeOptions,
  trims: { start: number; end: number }[],
  spans: number[],
  timeline: Timeline,
): Promise<Blob> {
  const reportProgress = makeProgress(options.onProgress, 'encode', options.signal);
  const buffer = await renderTimelineAudio(
    audioSegments(opened, trims, spans, timeline),
    timeline.total,
    options.signal,
  );
  reportProgress(0.9);
  return encodeMp3(buffer, options.signal);
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export async function mergeClips(clips: ClipInfo[], options: MergeOptions): Promise<MergeResult> {
  const { jobType, signal } = options;
  const crossfade = options.crossfadeSeconds ?? 0;
  const outputFormat = options.outputFormat ?? 'video';
  if (clips.length < 2) throw new MergeError('Select at least two clips to merge.');
  if (!Number.isFinite(crossfade) || crossfade < 0 || crossfade > 30) {
    throw new MergeError('Crossfade must be between 0 and 30 seconds.');
  }
  if (jobType === 'audio' && crossfade > 0) {
    throw new MergeError('Crossfades are only available for video merges.');
  }
  if (jobType === 'audio' && outputFormat === 'audio-mp3') {
    throw new MergeError('Audio-only MP3 export is only available for video merges.');
  }
  checkAborted(signal);

  for (const clip of clips) {
    if (!clip.file) {
      throw new MergeError(`"${clip.name}" is missing its media — use Locate on its clip card before merging.`);
    }
  }

  const opened = await openClips(clips);
  for (const o of opened) {
    if (jobType === 'video' && !o.videoTrack) {
      throw new MergeError(`"${o.clip.name}" contains no video track. Remove it and pick a different file.`);
    }
    if (jobType === 'audio' && !o.audioTrack) {
      throw new MergeError(`"${o.clip.name}" contains no audio track. Remove it and pick a different file.`);
    }
  }
  if (outputFormat === 'audio-mp3' && !opened.some((o) => o.audioTrack)) {
    throw new MergeError('None of these clips has an audio track, so there is no soundtrack to export as MP3.');
  }

  // Real (trimmed) spans are measured from the tracks, not just metadata.
  const trims = opened.map((o) => clipTrim(o.clip));
  const spans = await Promise.all(opened.map((o, i) => clipSpanOf(o, trims[i]!.start, trims[i]!.end)));
  const timeline = buildTimeline(spans, crossfade);
  const totalDuration = timeline.total;
  const useCopy = crossfade === 0 && outputFormat === 'video' && (await canCopyJoin(opened, jobType));

  if (!useCopy) {
    // The encode path decodes every participating track with WebCodecs.
    await assertTracksDecodable(opened, jobType);
  }

  let blob: Blob;
  if (outputFormat === 'audio-mp3') {
    blob = await mp3Join(opened, options, trims, spans, timeline);
  } else if (crossfade > 0) {
    blob = await crossfadeJoin(opened, options, spans, timeline);
  } else {
    blob = useCopy
      ? await copyJoin(opened, options, totalDuration)
      : await encodeJoin(opened, options, totalDuration);
  }

  const extension = outputFormat === 'audio-mp3' ? 'mp3' : jobType === 'audio' ? 'm4a' : 'mp4';
  return {
    blob,
    fileName: `merged-${outputFormat === 'audio-mp3' ? 'audio' : jobType}-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}.${extension}`,
    method: useCopy ? 'copy' : 'encode',
    duration: totalDuration,
    extension,
  };
}
