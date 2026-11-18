import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, 'smoke-tmp');
mkdirSync(dir, { recursive: true });

function generate(name: string, args: string[]) {
  if (existsSync(path.join(dir, name))) return;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, name], {
    cwd: dir,
    stdio: 'inherit',
  });
}

generate('joined_src.mp4', [
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-shortest',
]);
generate('seg1.mp4', ['-i', 'joined_src.mp4', '-t', '3', '-c', 'copy']);
generate('seg2.mp4', ['-ss', '3', '-i', 'joined_src.mp4', '-c', 'copy']);
generate('joined_audio.m4a', [
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'aac', '-b:a', '96k',
]);
generate('aseg1.m4a', ['-i', 'joined_audio.m4a', '-t', '2', '-c', 'copy']);
generate('aseg2.m4a', ['-ss', '2', '-i', 'joined_audio.m4a', '-c', 'copy']);
generate('long_audio.mp3', [
  '-f', 'lavfi', '-i', 'sine=frequency=200:duration=181', '-c:a', 'libmp3lame',
]);
generate('too_long_audio.mp3', [
  '-f', 'lavfi', '-i', 'sine=frequency=200:duration=601', '-c:a', 'libmp3lame', '-b:a', '32k',
]);

console.log('Media fixtures ready.');
