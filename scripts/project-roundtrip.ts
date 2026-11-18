/**
 * Node round-trip test for the .mixproj project container (src/lib/project.ts).
 * Validates the metadata-only format: buildProjectFile → parseProjectFile
 * fidelity (project name, job type, clip order, trims, codec facts, clip
 * identity via size), tiny container size (no media embedded), clips saved
 * while missing stay missing, and friendly failures for corrupted /
 * non-project / legacy files. Run: npm run projtest
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ProjectFileError, buildProjectFile, parseProjectFile, slugifyProjectName } from '../src/lib/project';
import { MAX_CROSSFADE_SECONDS, type ClipInfo, type JobType } from '../src/lib/model';

const FIXTURES = path.resolve(import.meta.dirname, 'smoke-tmp');

async function makeClip(name: string, mediaPath: string, type: JobType, trim: { start: number; end: number } | null): Promise<ClipInfo> {
  const bytes = readFileSync(path.join(FIXTURES, mediaPath));
  const file = new File([bytes], name, { type: type === 'video' ? 'video/mp4' : 'audio/mpeg' });
  return {
    id: `clip-${process.pid}`,
    file,
    name,
    sizeBytes: file.size,
    type,
    duration: type === 'video' ? 3.02 : 2.02,
    trimStart: trim?.start ?? null,
    trimEnd: trim?.end ?? null,
    video:
      type === 'video'
        ? { codec: 'avc', displayWidth: 640, displayHeight: 360, rotation: 0, flip: false, pixelAspectRatio: { num: 1, den: 1 }, canDecode: true }
        : undefined,
    audio: { codec: 'aac', sampleRate: 44100, numberOfChannels: 1, canDecode: true },
  };
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

/** A minimal pretend-legacy header so the magic check can be exercised. */
function buildLegacyV1Fixture(): Blob {
  const header = JSON.stringify({ format: 'MIXPROJv1', name: 'old', jobType: null, clips: [] });
  const bytes = new TextEncoder().encode('MIXPROJv1');
  const json = new TextEncoder().encode(header);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.length, true);
  return new Blob([bytes, length, json]);
}

async function main() {
  const clips = [
    await makeClip('scene-one.mp4', 'seg1.mp4', 'video', { start: 0.5, end: 2.9 }),
    await makeClip('scene-two.mp4', 'seg2.mp4', 'video', null),
    await makeClip('backing-track.mp3', 'long_audio.mp3', 'audio', null),
  ];

  const name = 'My "Weird": Project/Name <1>?';
  const blob = await buildProjectFile({
    name,
    jobType: 'video',
    clips,
    crossfadeSeconds: 1.25,
    outputFormat: 'audio-mp3',
  });
  console.log(`built ${(blob.size / 1024).toFixed(1)} KiB container`);
  // Metadata-only: three clips + no thumbnails must stay tiny.
  if (blob.size > 20 * 1024) fail(`container unexpectedly large (${blob.size} bytes) — media leaked in?`);

  const slug = slugifyProjectName(name);
  console.log(`slug: ${slug}`);
  if (slug !== 'My-Weird-Project-Name-1') fail(`unexpected slug ${slug}`);

  const parsed = await parseProjectFile(new File([blob], 'p.mixproj'));

  if (parsed.name !== name) fail('project name mismatch');
  if (parsed.jobType !== 'video') fail('job type mismatch');
  if (parsed.crossfadeSeconds !== 1.25) fail(`crossfade mismatch: ${parsed.crossfadeSeconds}`);
  if (parsed.outputFormat !== 'audio-mp3') fail(`export format mismatch: ${parsed.outputFormat}`);
  if (parsed.clips.length !== clips.length) fail('clip count mismatch');

  for (let i = 0; i < clips.length; i++) {
    const original = clips[i]!;
    const rebuilt = parsed.clips[i]!;
    if (rebuilt.name !== original.name) fail(`clip ${i} name`);
    if (rebuilt.trimStart !== original.trimStart || rebuilt.trimEnd !== original.trimEnd) fail(`clip ${i} trims`);
    if (rebuilt.type !== original.type) fail(`clip ${i} type`);
    if (rebuilt.video?.codec !== original.video?.codec) fail(`clip ${i} video meta`);
    if (rebuilt.video?.displayWidth !== original.video?.displayWidth) fail(`clip ${i} video size`);
    if (rebuilt.audio?.sampleRate !== original.audio?.sampleRate) fail(`clip ${i} audio meta`);
    if (rebuilt.sizeBytes !== original.sizeBytes) fail(`clip ${i} identity size`);
    if (rebuilt.file !== null) fail(`clip ${i} must start unlinked (media is not embedded)`);
  }
  console.log('round-trip: metadata, order, trims, crossfade, export and identity are preserved ✓ (all clips unlinked)');

  // A clip saved while its media was already missing stays missing.
  const unlinked = clips.map((c, i) => (i === 1 ? { ...c, file: null } : c));
  const parsedMissing = await parseProjectFile(
    new File([await buildProjectFile({ name: 'partly-missing', jobType: 'video', clips: unlinked })], 'q.mixproj'),
  );
  if (parsedMissing.clips[1]!.file !== null || parsedMissing.clips[0]!.file !== null) {
    fail('missing clip handling broke');
  }
  if (parsedMissing.crossfadeSeconds !== null || parsedMissing.outputFormat !== null) {
    fail('projects without crossfade/export settings should still open');
  }
  console.log('saved-missing clips stay missing on open ✓');
  console.log('older projects without crossfade/export settings open cleanly ✓');

  const clamped = await parseProjectFile(
    new File([await buildProjectFile({ name: 'clamped', jobType: 'video', clips, crossfadeSeconds: 9 })], 'c.mixproj'),
  );
  if (clamped.crossfadeSeconds !== MAX_CROSSFADE_SECONDS) fail('out-of-range crossfade was not clamped');
  console.log('out-of-range crossfade values are clamped ✓');

  // Legacy v1 containers (which embedded media) get a pointed message.
  try {
    const legacy = buildLegacyV1Fixture();
    await parseProjectFile(new File([legacy], 'old.mixproj'));
    fail('legacy v1 file did not throw');
  } catch (err) {
    if (!(err instanceof ProjectFileError) || !err.message.includes('older Media Mixer version')) {
      fail('legacy v1 file threw the wrong error');
    }
    console.log('legacy v1 → friendly rejection ✓');
  }

  // Corrupt content: truncated before its declared contents end.
  const keep = Math.floor(blob.size / 2);
  const truncated = new Uint8Array(keep);
  truncated.set(new Uint8Array(await blob.arrayBuffer()).subarray(0, keep));
  try {
    await parseProjectFile(new File([truncated], 'trunc.mixproj'));
    fail('truncated file did not throw');
  } catch (err) {
    if (!(err instanceof ProjectFileError)) fail('truncated file threw the wrong error type');
    console.log(`truncated → ${err instanceof Error ? err.message : err}`);
  }

  // A random non-project file (video fixture itself).
  try {
    await parseProjectFile(new File([new Uint8Array(readFileSync(path.join(FIXTURES, 'seg1.mp4')))], 'not-a-project.mp4'));
    fail('non-project file did not throw');
  } catch (err) {
    if (!(err instanceof ProjectFileError)) fail('non-project file threw the wrong error type');
    console.log(`not-a-project → ${err instanceof Error ? err.message : err}`);
  }

  console.log('all project-file checks passed.');
}

void main();
