# Media Mixer

Join any number of videos — or any number of audios — into a single file, **entirely in your browser**. Files are never uploaded: all inspecting, copying, decoding, encoding, and playing happens client-side.

Built with [Next.js 16](https://nextjs.org) + [Tailwind CSS 4](https://tailwindcss.com), merged with [mediabunny](https://mediabunny.dev) and the [WebCodecs API](https://www.w3.org/TR/webcodecs/).

## Features

- **Any number of clips, any order.** The first file you accept sets the job type (video or audio); every following file must be the same type.
- **Trim each clip.** Every clip card has a ✂ trim editor (preview playback, editable Start/End `MM:SS.hh` fields + sliders, set-point-from-playhead, "Preview trim" loop) that keeps only the `[start, end)` span in the merge. ⧉ duplicate copies a trimmed clip directly below it so the same span can be merged again.
- **Play all before merging.** The ▶ Play all button plays every clip's trimmed span in order with pause/resume and stop. When crossfade is enabled, the preview overlaps the picture and sound with the same timing the merge will use — no merge happens until you press Merge.
- **Crossfades for videos.** Enable "Crossfade clips" and set 0.01–2 s of overlap with the slider or by typing an exact value (e.g. `0.75`, `0.75s`, or `00:00.75`): adjacent clips dissolve picture and audio together. Overlaps are clamped to short clips, and the result is always re-encoded for accurate fades.
- **Audio-only MP3 export.** For video jobs, set Export to "Audio only (MP3)" to extract the (optionally crossfaded) soundtrack as a real `.mp3`, encoded in the browser with lamejs.
- **Projects survive refreshes.** Name a project at the top; every change auto-saves locally (IndexedDB, media bytes included) and is silently restored on reload — refreshes don't lose work. While clips are queued, leaves/refreshes pop the browser's stay-on-page warning. **Save project** downloads a named, tiny `.mixproj` project file — **metadata only** (order, trims, codec facts, crossfade length, export format, thumbnails; never media). **Open project…** restores those settings and re-links each clip by name + size automatically (files still present in the local auto-save bind instantly); clips whose source was moved or deleted get an amber "⚠ media missing" warning card with a ⤒ locate button, and merging stays disabled until every clip is linked.
- **10-minute rule** — enforced for you: files longer than `10:00` are rejected on add with their measured duration.
- **Lossless fast path.** When all clips share compatible codecs/parameters (same codec, dimensions, rotation, sample rate, etc.), the merge copies encoded packets byte-for-byte with just re-timestamped offsets — no quality loss, takes seconds.
- **Universal fallback.** Mixed sources (MP4 + WebM, MP3 + WAV, different sizes…) are decoded and re-encoded **once** into a common format — H.264/AAC MP4 for videos (capped at 1080p-long-edge normalization, letterboxed if sizes differ), AAC `.m4a` for audio — using the browser's hardware encoders.
- **Instant playback + per-clip preview.** Every clip card has a ▶ button that plays the original file inline; the merged result plays inline and can be downloaded (`merged-video-*.mp4` / `merged-audio-*.m4a`) — the **file name is editable before saving**, with illegal characters stripped and the correct extension re-appended automatically.
- **Live progress & cancellation**, drag & drop, per-clip thumbnails, reorder controls, and a browser-capability banner where WebCodecs is missing.
- **Light and dark modes.** The header toggle switches themes and saves your choice locally; before you choose, the site follows your device preference.

## How it runs

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build (fully static, can be hosted anywhere)
```

There is no API route and no server-side media handling. The support button in the header loads its image from Buy Me a Coffee; media files are never sent there.

## Check before deploying

Install [FFmpeg](https://ffmpeg.org/) (with `libx264` and `libmp3lame`) and, once, the test browser:

```bash
npm ci
npx playwright install chromium
npm test
```

`npm test` lints, generates local media fixtures if missing, checks project-file round-trips and lossless media merges, builds the production app (including TypeScript), then runs Chromium browser tests against that production build. The browser checks theme contrast and persistence, uploads and downloads a merged video, restores an auto-saved project, and rejects overlong media. **Do not deploy if any step fails.** Browser encoding and every codec/browser combination are not covered by this suite.

## Engine internals (`src/lib/merge.ts`)

| Method | When | How |
| --- | --- | --- |
| `copy` | All clips' primary tracks mutually compatible (codecs + decoder-config descriptions, resolution, rotation, flip, PAR, sample rate/channels) **and** every trimmed start is keyframe-reachable within 2 s | `EncodedPacketSink` → re-stamped packets → `EncodedVideoPacketSource` / `EncodedAudioPacketSource`. Starts from each clip's first verified `keyframe packet` at-or-after its trim start, mirrors mediabunny's own `Conversion` **shrink** boundary policy: video packets are clamped into the trim window (misordered key packets demoted to delta), audio packets that spill past the trim end are dropped. Clips without audio become silence spans. |
| `encode` | Any param mismatch, or a trim start farther than 2 s from the nearest keyframe | `VideoSampleSink` / `AudioSampleSink` decode (trim-exact: `samples(start, end)`) → per-frame timestamps shifted by the clip's kept span → single `VideoSampleSource`/`AudioSampleSource` encode. Audio resampling/upmixing handled by mediabunny's `transform`. |

Track-span offsets use `track.computeDuration()` so the merged timeline stays continuous even when audio runs longer than video (and vice versa).

## Smoke test (Node)

The library's demux/mux is pure JS, so the copy path (and file probing) is testable outside a browser with plain Node via tsx:

```bash
npm run test:media
```

It probes `scripts/smoke-tmp/*` fixtures and runs five scenarios: untrimmed video copy-join, untrimmed audio copy-join, mixed-type rejection, trimmed video copy-join (`[1.0, 2.5)` + `[0, 1.5)`), and trimmed audio copy-join (`[0.5, 2.0)` + `[1.0, 3.0)`) — printing the chosen method for each. Outputs land in `scripts/smoke-tmp/merged_video.mp4`, `merged_audio.m4a`, `merged_video_trimmed.mp4`, and `merged_audio_trimmed.m4a`; validate them with `ffprobe` (trimmed outputs come out at 3.00 s and ≈3.47 s respectively — audio tails that spill past the trim end are dropped, per mediabunny's shrink policy).

Fixtures are created in the ignored `scripts/smoke-tmp/` directory by FFmpeg when absent.

(The re-encode path needs WebCodecs, so it must be exercised in a real browser — Chrome, Edge, or Safari.)

## Browser support & limitations

- **Chrome / Edge / Safari**: full support. Capability gaps degrade gracefully instead of blocking: a browser missing the WebCodecs APIs shows a "can't run merges" banner, while browsers that merely lack a *specific* encoder (e.g., Chromium builds without an AAC encoder) get an informational banner — lossless copy merges and fallback codecs (H.264/VP9/AV1/VP8 video, AAC/Opus/FLAC audio in MP4) still work, and merges that truly need an impossible step fail with a precise error.
- Output lives in memory (`BufferTarget`): very large merged outputs are limited by the tab's memory. Practical ceiling is a few hundred MB.
- Exotic sources (e.g., AVI, HEVC in unsupported configs) that the browser can't decode get a ⚠ "no decoder in this browser" badge on their clip card; if a merge needs the re-encode path (mixed parameters), it stops early with a per-clip, actionable error instead of a raw demuxer error. Losslessly copy-joinable matches still merge fine.
- Two files encoded separately by the *same tool* sometimes still differ in their codec description bytes (SPS/PPS VUI); the engine then takes the re-encode route rather than producing stream corruptions. Fast path triggers reliably for same-source splits (e.g., segment cuts of one video) or identical exports.

## Layout

```
src/
├─ app/                 Next.js App Router shell (layout, page)
├─ components/Mixer.tsx client UI: drop zone, clip list, progress, player
└─ lib/
   ├─ model.ts          shared types + constants (MAX_CLIP_SECONDS = 600)
   ├─ probe.ts          file inspection + thumbnail via mediabunny
   ├─ merge.ts          the join engine (copy & encode strategies)
   └─ support.ts        WebCodecs capability detection
scripts/
├─ smoke.ts             Node smoke test for probe + copy-join
└─ smoke-tmp/           generated fixtures and outputs
```
