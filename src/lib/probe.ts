/**
 * File inspection: turns a user-selected File into a ClipInfo (or a rejection
 * reason). Runs entirely client-side through mediabunny's pure-JS demuxers,
 * plus a WebCodecs decode of a single frame for the thumbnail.
 */
import type { Input, InputVideoTrack } from 'mediabunny';
import type { AudioInfo, VideoInfo } from './model';

export type ProbeOutcome =
  | { ok: true; clip: Omit<import('./model').ClipInfo, 'id'> }
  | { ok: false; reason: string };

let mb: typeof import('mediabunny') | null = null;
async function lib(): Promise<typeof import('mediabunny')> {
  return (mb ??= await import('mediabunny'));
}

/** Opens a media file with all container formats enabled. */
export async function openFile(file: File): Promise<Input> {
  const { Input, ALL_FORMATS, BlobSource } = await lib();
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
}

export async function probeFile(file: File): Promise<ProbeOutcome> {
  try {
    const input = await openFile(file);
    const [duration, videoTrack, audioTrack] = await Promise.all([
      input.computeDuration(),
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);

    if (!videoTrack && !audioTrack) {
      return { ok: false, reason: 'Not a media file (no video or audio tracks found).' };
    }

    let video: VideoInfo | undefined;
    let thumbnailUrl: string | undefined;
    if (videoTrack) {
      const [codec, displayWidth, displayHeight, rotation, flip, pixelAspectRatio, canDecode] = await Promise.all([
        videoTrack.getCodec(),
        videoTrack.getDisplayWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getRotation(),
        videoTrack.getFlip(),
        videoTrack.getPixelAspectRatio(),
        videoTrack.canDecode(),
      ]);
      if (!codec) return { ok: false, reason: `Video codec of "${file.name}" is unsupported or unknown.` };

      video = {
        codec,
        displayWidth,
        displayHeight,
        rotation,
        flip,
        pixelAspectRatio: { num: pixelAspectRatio.num, den: pixelAspectRatio.den },
        canDecode,
      };
      thumbnailUrl = await makeThumbnail(videoTrack).catch(() => undefined);
    }

    let audio: AudioInfo | undefined;
    if (audioTrack) {
      const [codec, sampleRate, numberOfChannels, canDecode] = await Promise.all([
        audioTrack.getCodec(),
        audioTrack.getSampleRate(),
        audioTrack.getNumberOfChannels(),
        audioTrack.canDecode(),
      ]);
      if (!codec) return { ok: false, reason: `Audio codec of "${file.name}" is unsupported or unknown.` };
      audio = { codec, sampleRate, numberOfChannels, canDecode };
    }

    // Files with a video track are 'video' even if they also carry audio.
    const type = video ? ('video' as const) : ('audio' as const);

    return {
      ok: true,
      clip: {
        file,
        name: file.name,
        sizeBytes: file.size,
        type,
        duration,
        trimStart: null,
        trimEnd: null,
        video,
        audio,
        thumbnailUrl,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? `${file.name}: ${err.message}` : `Could not read ${file.name}.`,
    };
  }
}

/** Renders a small JPEG poster frame for a video track. Best effort. */
async function makeThumbnail(videoTrack: InputVideoTrack): Promise<string | undefined> {
  const { CanvasSink } = (await lib());

  const sink = new CanvasSink(videoTrack, { width: 256 });
  const firstTimestamp = await videoTrack.getFirstTimestamp();
  const wrapped = await sink.getCanvas(firstTimestamp);
  if (!wrapped) return undefined;

  const { canvas } = wrapped;
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    return URL.createObjectURL(blob);
  }
  const htmlCanvas = canvas as HTMLCanvasElement;
  return new Promise<string>((resolve, reject) => {
    htmlCanvas.toBlob(
      (blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('Thumbnail encoding failed.'))),
      'image/jpeg',
      0.75,
    );
  });
}
