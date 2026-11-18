/**
 * Node smoke test for the browser merge engine (fast/copy path only —
 * the re-encode path needs WebCodecs and must be tested in a real browser).
 *
 * Run: node scripts/smoke.ts   (ffprobe validates outputs afterwards)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { probeFile } from '../src/lib/probe';
import type { ClipInfo } from '../src/lib/model';
import { mergeClips } from '../src/lib/merge';

const tmpDir = path.join(import.meta.dirname!, 'smoke-tmp');

async function assertOutput(blob: Blob, name: string, type: 'video' | 'audio', duration: number) {
  assert.ok(blob.size > 0);
  const outcome = await probeFile(new File([blob], name));
  assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.reason);
  if (outcome.ok) {
    assert.equal(outcome.clip.type, type);
    assert.ok(Math.abs(outcome.clip.duration - duration) < 0.15, `${name}: unexpected output duration`);
  }
}

async function loadClip(name: string): Promise<ClipInfo> {
  const file = new File([readFileSync(path.join(tmpDir, name))], name);
  const outcome = await probeFile(file);
  if (!outcome.ok) throw new Error(`probe failed for ${name}: ${outcome.reason}`);
  return { ...outcome.clip, id: name };
}

async function main(): Promise<void> {
  console.log('— probing files —');
  const [clipA, clipB, audioA, audioB, longAudio] = await Promise.all([
    loadClip('seg1.mp4'),
    loadClip('seg2.mp4'),
    loadClip('aseg1.m4a'),
    loadClip('aseg2.m4a'),
    loadClip('long_audio.mp3'),
  ]);

  for (const [name, clip] of (
    [
      ['seg1', clipA],
      ['seg2', clipB],
      ['aseg1', audioA],
      ['aseg2', audioB],
      ['long_audio', longAudio],
    ] as const
  )) {
    console.log(
      `${name}: type=${clip.type} dur=${clip.duration.toFixed(2)}s`,
      clip.video ? `v=${clip.video.codec}(${clip.video.displayWidth}x${clip.video.displayHeight} rot=${clip.video.rotation})` : 'v=-',
      clip.audio ? `a=${clip.audio.codec}/${clip.audio.sampleRate}/${clip.audio.numberOfChannels}ch` : 'a=-',
    );
  }
  console.log();

  // 1. Video copy-join with two same-spec clips (kept for ffprobe).
  console.log('— mergeClips(seg1, seg2) [video] —');
  const mergedVideo = await mergeClips([clipA, clipB], {
    jobType: 'video',
  });
  console.log(`method=${mergedVideo.method} duration=${mergedVideo.duration.toFixed(2)}s bytes=${mergedVideo.blob.size}`);
  assert.equal(mergedVideo.method, 'copy');
  assert.ok(Math.abs(mergedVideo.duration - 6) < 0.1);
  await assertOutput(mergedVideo.blob, 'merged_video.mp4', 'video', 6);
  writeFileSync(path.join(tmpDir, 'merged_video.mp4'), Buffer.from(await mergedVideo.blob.arrayBuffer()));

  // 2. Audio copy-join with two aac clips (kept for ffprobe).
  console.log('— mergeClips(aseg1, aseg2) [audio] —');
  const mergedAudio = await mergeClips([audioA, audioB], { jobType: 'audio' });
  console.log(`method=${mergedAudio.method} duration=${mergedAudio.duration.toFixed(2)}s bytes=${mergedAudio.blob.size}`);
  assert.equal(mergedAudio.method, 'copy');
  assert.ok(Math.abs(mergedAudio.duration - 5) < 0.1);
  await assertOutput(mergedAudio.blob, 'merged_audio.m4a', 'audio', 5);
  writeFileSync(path.join(tmpDir, 'merged_audio.m4a'), Buffer.from(await mergedAudio.blob.arrayBuffer()));

  // 3. A video job must reject an audio-only file.
  await assert.rejects(mergeClips([clipA, audioA], { jobType: 'video' }), /contains no video track/);
  console.log('mixed job rejected as expected');

  // 4. Trimmed video copy-join: keyframe-aligned cuts on both clips.
  //    seg1 keeps [1.0, 2.5); seg2 keeps [0, 1.5). Expect method=copy and
  //    ~2.5 s of output (validated with ffprobe).
  console.log('— mergeClips(trim(seg1: 1.0→2.5), trim(seg2: 0→1.5)) [video] —');
  const trimmedA = { ...clipA, trimStart: 1.0, trimEnd: 2.5 };
  const trimmedB = { ...clipB, trimStart: 0, trimEnd: 1.5 };
  const mergedTrimmed = await mergeClips([trimmedA, trimmedB], { jobType: 'video' });
  console.log(`method=${mergedTrimmed.method} duration=${mergedTrimmed.duration.toFixed(2)}s bytes=${mergedTrimmed.blob.size}`);
  assert.equal(mergedTrimmed.method, 'copy');
  assert.ok(Math.abs(mergedTrimmed.duration - 3) < 0.1);
  await assertOutput(mergedTrimmed.blob, 'merged_video_trimmed.mp4', 'video', 3);
  writeFileSync(path.join(tmpDir, 'merged_video_trimmed.mp4'), Buffer.from(await mergedTrimmed.blob.arrayBuffer()));

  // 5. Trimmed audio copy-join: mid-cut (AAC packets are freely cuttable).
  console.log('— mergeClips(trim(aseg1: 0.5→2.0), trim(aseg2: 1.0→3.0)) [audio] —');
  const trimmedAA = { ...audioA, trimStart: 0.5, trimEnd: 2.0 };
  const trimmedBB = { ...audioB, trimStart: 1.0, trimEnd: 3.0 };
  const mergedTrimmedAudio = await mergeClips([trimmedAA, trimmedBB], { jobType: 'audio' });
  console.log(`method=${mergedTrimmedAudio.method} duration=${mergedTrimmedAudio.duration.toFixed(2)}s bytes=${mergedTrimmedAudio.blob.size}`);
  assert.equal(mergedTrimmedAudio.method, 'copy');
  assert.ok(Math.abs(mergedTrimmedAudio.duration - 3.5) < 0.1);
  await assertOutput(mergedTrimmedAudio.blob, 'merged_audio_trimmed.m4a', 'audio', 3.5);
  writeFileSync(path.join(tmpDir, 'merged_audio_trimmed.m4a'), Buffer.from(await mergedTrimmedAudio.blob.arrayBuffer()));

  console.log('done.');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
