/**
 * Browser-support detection for the merge engine.
 *
 * The app merges media entirely client-side using the WebCodecs API (see
 * src/lib/merge.ts). Two tiers of requirements:
 *
 *  - Hard requirements: the WebCodecs classes must exist at all (and
 *    mediabunny must load). Without them nothing can run, and the UI blocks
 *    merging entirely.
 *  - Codec capability: the engine never relies on one codec — it falls back
 *    across H.264/VP9/AV1/VP8 for video and AAC/Opus/FLAC for audio, all of
 *    which mediabunny can mux into MP4. So a *specific* gap (e.g. a Chromium
 *    build without an AAC encoder) only degrades the feature set: lossless
 *    copy merges and fallback codecs still work. These surface as warnings,
 *    and precise errors are raised at merge time if a decode/encode is
 *    actually required and impossible.
 */

export interface SupportReport {
  /** Whether merging can work at all in this browser. */
  supported: boolean;
  /** Human-readable list of problems, shown when unsupported. */
  problems: string[];
  /** Non-blocking capability gaps, shown as an informational banner. */
  warnings: string[];
}

export async function getSupportReport(): Promise<SupportReport> {
  const problems: string[] = [];
  const warnings: string[] = [];

  const missing = (['VideoEncoder', 'VideoDecoder', 'AudioEncoder', 'AudioDecoder'] as const).filter(
    (api) => typeof window === 'undefined' || !(api in window),
  );
  if (missing.length > 0) {
    problems.push(`This browser is missing the WebCodecs APIs (${missing.join(', ')}) needed for in-browser merging.`);
    problems.push('Try the latest Chrome, Edge, or Safari.');
    return { supported: false, problems, warnings };
  }

  try {
    const {
      getFirstEncodableVideoCodec,
      getFirstEncodableAudioCodec,
      canDecodeVideo,
      canDecodeAudio,
    } = await import('mediabunny');

    // Mirror the engine's own fallback lists (codecs it tries, capped at the
    // same 1920 px long edge) so detection matches what a merge can really do.
    const videoEncode = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'], {
      width: 1920,
      height: 1080,
    });
    if (!videoEncode) {
      warnings.push(
        "This browser can't re-encode video (no H.264, VP9, AV1, or VP8 encoder) — only lossless copy merges of matching clips will work.",
      );
    }

    // Audio jobs may also fall back to FLAC; video jobs need AAC or Opus.
    const [audioEncodeAny, audioEncodeCommon] = await Promise.all([
      getFirstEncodableAudioCodec(['aac', 'opus', 'flac']),
      getFirstEncodableAudioCodec(['aac', 'opus']),
    ]);
    if (!audioEncodeAny) {
      warnings.push(
        "This browser can't re-encode audio (no AAC, Opus, or FLAC encoder) — only lossless copy merges of matching clips will work.",
      );
    } else if (!audioEncodeCommon) {
      warnings.push(
        "This browser can't re-encode audio to AAC or Opus, but can to FLAC — video merges need the lossless copy path to succeed.",
      );
    }

    // Decoding only matters for the re-encode path; the copy path never decodes.
    const canVideoDecode = (await canDecodeVideo('avc')) || (await canDecodeVideo('vp9'));
    if (!canVideoDecode) {
      warnings.push(
        "This browser can't decode common video codecs (H.264/VP9) — mixed or trimmed video merges that need re-encoding will fail; lossless copy merges still work.",
      );
    }
    const canAudioDecode =
      (await canDecodeAudio('aac')) || (await canDecodeAudio('opus')) || (await canDecodeAudio('mp3'));
    if (!canAudioDecode) {
      warnings.push(
        "This browser can't decode common audio codecs (AAC, Opus, MP3) — merges that rely on re-encoding will fail; lossless copy merges still work.",
      );
    }
  } catch {
    problems.push('Media libraries failed to load. Reload the page and retry.');
  }

  return { supported: problems.length === 0, problems, warnings };
}
