/**
 * Audio timeline rendering for crossfades and audio-only exports.
 *
 * Web Audio's OfflineAudioContext does the resampling and channel mixing for
 * us, so clips with different sample rates/channel counts can share one
 * timeline. The rendered buffer is then either handed to mediabunny (for an
 * MP4 soundtrack) or encoded to MP3 with lamejs.
 */
import type { InputAudioTrack } from 'mediabunny';

/** Fixed output rate: supported by lamejs and by every browser's WebCodecs. */
export const AUDIO_RATE = 44100;
export const AUDIO_CHANNELS = 2;

/** One audio clip's placement on the output timeline. */
export interface AudioTimelineSegment {
  track: InputAudioTrack | null;
  trimStart: number;
  trimEnd: number;
  /** Where this clip starts on the output timeline. */
  start: number;
  span: number;
  fadeIn: number;
  fadeOut: number;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MergeCanceledFromAudio();
}

// Local error classes avoid a runtime import cycle with merge.ts.
class MergeCanceledFromAudio extends Error {
  constructor() {
    super('Merge canceled.');
    this.name = 'MergeCanceledError';
  }
}

class AudioMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeError';
  }
}

function gainAt(segment: AudioTimelineSegment, time: number): number {
  let gain = 1;
  const fadeInEnd = segment.start + segment.fadeIn;
  const fadeOutStart = segment.start + segment.span - segment.fadeOut;
  if (segment.fadeIn > 0 && time < fadeInEnd) {
    gain *= Math.max(0, Math.min(1, (time - segment.start) / segment.fadeIn));
  }
  if (segment.fadeOut > 0 && time > fadeOutStart) {
    gain *= Math.max(0, Math.min(1, (fadeOutStart + segment.fadeOut - time) / segment.fadeOut));
  }
  return gain;
}

/**
 * Decodes every clip's trimmed audio into one buffer, applying the fade-in /
 * fade-out ramps. Gaps (clips without audio, or trims with no sound) stay
 * silent, keeping the soundtrack aligned with the video timeline.
 */
export async function renderTimelineAudio(
  segments: AudioTimelineSegment[],
  totalDuration: number,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(totalDuration * AUDIO_RATE));
  const context = new OfflineAudioContext(AUDIO_CHANNELS, length, AUDIO_RATE);

  for (const segment of segments) {
    checkAborted(signal);
    if (!segment.track) continue;

    const { AudioSampleSink } = await import('mediabunny');
    const sink = new AudioSampleSink(segment.track);

    for await (const sample of sink.samples(segment.trimStart, segment.trimEnd)) {
      checkAborted(signal);
      const buffer = sample.toAudioBuffer();
      const rawStart = segment.start + sample.timestamp - segment.trimStart;
      sample.close();
      if (buffer.length === 0) continue;

      const start = Math.max(0, rawStart);
      const end = Math.min(totalDuration, rawStart + buffer.duration);
      if (end <= start) continue;

      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.setValueCurveAtTime(
        Float32Array.from([gainAt(segment, rawStart), gainAt(segment, rawStart + buffer.duration)]),
        start,
        end - start,
      );
      source.connect(gain).connect(context.destination);
      // Skip the part of the buffer that falls before the timeline started.
      source.start(start, rawStart < 0 ? -rawStart : 0);
    }
  }

  return context.startRendering();
}

function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]!));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

/** Encodes a rendered buffer into a real MPEG-1 Layer III (.mp3) file. */
export async function encodeMp3(buffer: AudioBuffer, signal?: AbortSignal): Promise<Blob> {
  checkAborted(signal);
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  if (buffer.sampleRate !== AUDIO_RATE) {
    throw new AudioMergeError(`MP3 export needs ${AUDIO_RATE} Hz audio, got ${buffer.sampleRate} Hz.`);
  }
  if (buffer.numberOfChannels > 2) {
    throw new AudioMergeError('MP3 export supports mono or stereo audio only.');
  }

  const encoder = new Mp3Encoder(buffer.numberOfChannels, buffer.sampleRate, 192);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels === 2 ? buffer.getChannelData(1) : undefined;
  // LAME encodes in 1152-sample MPEG-1 frames.
  const blockSize = 1152;
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < buffer.length; offset += blockSize) {
    checkAborted(signal);
    const sliceLeft = left.subarray(offset, offset + blockSize);
    const sliceRight = right?.subarray(offset, offset + blockSize);
    const bytes = encoder.encodeBuffer(
      floatToPcm16(sliceLeft),
      sliceRight ? floatToPcm16(sliceRight) : undefined,
    );
    if (bytes.length > 0) chunks.push(bytes);
  }

  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(tail);
  if (chunks.length === 0) throw new AudioMergeError('MP3 encoding produced no data.');

  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}
