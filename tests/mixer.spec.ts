import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { probeFile } from '../src/lib/probe';

const fixture = (name: string) => path.join(process.cwd(), 'scripts', 'smoke-tmp', name);

async function expectReadableTheme(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  const { background, contrast } = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const text = getComputedStyle(document.querySelector('header p')!);
    const luminance = (color: string) => {
      const channels = color.match(/\d+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`Unexpected color: ${color}`);
      const [r, g, b] = channels.map((n) => {
        const c = n / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const a = luminance(body.backgroundColor);
    const b = luminance(text.color);
    return {
      background: body.backgroundColor,
      contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    };
  });
  expect(background).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(10, 10, 10)');
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}

test('switches between readable themes and remembers the selection', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expectReadableTheme(page, 'dark');

  await page.getByRole('button', { name: 'Light mode' }).click();
  await expectReadableTheme(page, 'light');
  await expect(page.getByRole('button', { name: 'Dark mode' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('media-mixer-theme'))).toBe('light');

  await page.reload();
  await expectReadableTheme(page, 'light');
  await page.getByRole('button', { name: 'Dark mode' }).click();
  await expectReadableTheme(page, 'dark');

  const supportLink = page.getByRole('link', { name: 'Buy me a beer' });
  await expect(supportLink).toHaveAttribute('href', 'https://www.buymeacoffee.com/ccobus');
  await expect(supportLink).toHaveAttribute('rel', 'noopener noreferrer');
});

test('uploads, merges and downloads videos, then restores the project', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.locator('input[accept="video/*,audio/*"]').first().setInputFiles([
    fixture('seg1.mp4'),
    fixture('seg2.mp4'),
  ]);
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Merge 2 clips' })).toBeEnabled();

  const saved = () => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('media-mixer');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const item = db.transaction('projects').objectStore('projects').get('current');
      item.onerror = () => reject(item.error);
      item.onsuccess = () => {
        resolve(item.result?.clips?.length === 2);
        db.close();
      };
    };
  }));
  await expect.poll(saved, { timeout: 10_000 }).toBe(true);

  await page.getByRole('button', { name: 'Merge 2 clips' }).click();
  const downloadLink = page.getByRole('link', { name: 'Download' });
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download');
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  const bytes = await readFile(await download.path());
  assert.ok(bytes.length > 100);
  assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');

  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();
  await expect(page.getByText('Restored your last project')).toBeVisible();
});

test('rejects media longer than ten minutes', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.locator('input[accept="video/*,audio/*"]').first().setInputFiles(fixture('too_long_audio.mp3'));
  await expect(page.getByRole('alert').filter({ hasText: 'Only media up to 10 minutes can be merged.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Clips/ })).toHaveCount(0);
});

test('edits trim start and end as MM:SS.hh timecodes', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[accept="video/*,audio/*"]').first().setInputFiles(fixture('seg1.mp4'));
  await expect(page.getByRole('heading', { name: /Clips \(1\)/ })).toBeVisible();
  await page.getByRole('button', { name: /trim/ }).click();

  const start = page.getByRole('textbox', { name: 'Trim start time' });
  await start.fill('00:01.00');
  await start.press('Enter');
  await expect(start).toHaveValue('00:01.00');
  await expect(page.getByRole('slider', { name: 'Trim start' })).toHaveValue('1');

  const end = page.getByRole('textbox', { name: 'Trim end time' });
  await end.fill('00:02.50');
  await end.press('Enter');
  await expect(end).toHaveValue('00:02.50');
  await expect(page.getByRole('slider', { name: 'Trim end' })).toHaveValue('2.5');
});

test('previews all clips in order without merging', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[accept="video/*,audio/*"]').first().setInputFiles([
    fixture('seg1.mp4'),
    fixture('seg2.mp4'),
  ]);
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();
  await page.getByRole('button', { name: '▶ Play all' }).click();

  const status = page.getByText(/Previewing 1 of 2/);
  await expect(status).toBeVisible();
  await expect(status).toContainText('seg1.mp4');

  await page.locator('video:visible').evaluate((el) => el.dispatchEvent(new Event('ended')));
  await expect(page.getByText(/Previewing 2 of 2/)).toContainText('seg2.mp4');

  await page.getByRole('button', { name: /Stop/ }).click();
  await expect(page.getByText(/Previewing/)).toBeHidden();
});

test('previews the configured crossfade with overlapping sound and picture', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[accept="video/*,audio/*"]').first().setInputFiles([
    fixture('seg1.mp4'),
    fixture('seg2.mp4'),
  ]);
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Enable crossfade' }).check();
  const duration = page.getByRole('textbox', { name: 'Crossfade duration value' });
  await duration.fill('1.25');
  await duration.press('Enter');
  await expect(duration).toHaveValue('1.25');
  await expect(page.getByRole('slider', { name: 'Crossfade duration' })).toHaveValue('1.25');

  await page.getByRole('button', { name: '▶ Play all' }).click();
  const videos = page.locator('video:visible');
  await expect(videos).toHaveCount(1);
  await expect
    .poll(() => videos.first().evaluate((el) => (el as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);

  // Jump to the first join: the outgoing clip fades out while the next fades in.
  await videos.first().evaluate((el) => {
    const video = el as HTMLVideoElement;
    video.currentTime = Math.max(0, video.duration - 1.26);
    video.dispatchEvent(new Event('timeupdate'));
  });
  await expect(videos).toHaveCount(2);
  await expect
    .poll(() => videos.evaluateAll((elements) => elements.filter((el) => (el as HTMLVideoElement).volume > 0.05).length))
    .toBe(2);
  const opacities = await videos.evaluateAll((elements) =>
    elements.map((el) => Number((el as HTMLElement).style.opacity || '1')),
  );
  expect(opacities.some((value) => value > 0 && value < 1)).toBe(true);

  await page.getByRole('button', { name: /Stop/ }).click();
  await expect(videos).toHaveCount(0);
});

test('duplicates a trimmed clip for merging', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[accept="video/*,audio/*"]').first().setInputFiles(fixture('seg1.mp4'));
  await expect(page.getByRole('heading', { name: /Clips \(1\)/ })).toBeVisible();
  await page.getByRole('button', { name: /trim/ }).click();
  const start = page.getByRole('textbox', { name: 'Trim start time' });
  await start.fill('00:01.00');
  await start.press('Enter');
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: /duplicate/ }).click();
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Merge 2 clips' })).toBeEnabled();

  const copy = page.locator('ol > li').nth(1);
  await copy.getByRole('button', { name: /trim/ }).click();
  await expect(copy.getByRole('textbox', { name: 'Trim start time' })).toHaveValue('00:01.00');

  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Merge 2 clips' }).click();
  await expect(page.getByRole('link', { name: 'Download' })).toBeVisible({ timeout: 30_000 });
});

test('keeps clip keys unique after restoring a project', async ({ page }) => {
  const duplicateKeyErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /same key/i.test(message.text())) duplicateKeyErrors.push(message.text());
  });

  await page.goto('/');
  const picker = page.locator('input[accept="video/*,audio/*"]').first();
  await picker.setInputFiles(fixture('seg1.mp4'));
  await expect(page.getByRole('heading', { name: /Clips \(1\)/ })).toBeVisible();

  const saved = () => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('media-mixer');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const item = db.transaction('projects').objectStore('projects').get('current');
      item.onerror = () => reject(item.error);
      item.onsuccess = () => {
        resolve(item.result?.clips?.length === 1);
        db.close();
      };
    };
  }));
  await expect.poll(saved, { timeout: 10_000 }).toBe(true);

  await page.reload();
  await expect(page.getByRole('heading', { name: /Clips \(1\)/ })).toBeVisible();
  await expect(page.getByText('Restored your last project')).toBeVisible();

  // This used to reuse "clip-1" and warn about duplicate React keys.
  await picker.setInputFiles(fixture('seg2.mp4'));
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();
  await page.waitForTimeout(200);
  expect(duplicateKeyErrors).toEqual([]);
});

test('saves and opens a project with trims, crossfade and export settings', async ({ page }) => {
  await page.goto('/');
  const picker = page.locator('input[accept="video/*,audio/*"]').first();
  await picker.setInputFiles([fixture('seg1.mp4'), fixture('seg2.mp4')]);
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();

  await page.getByRole('textbox', { name: 'Project name' }).fill('Round trip');
  const first = page.locator('ol > li').first();
  await first.getByRole('button', { name: /trim/ }).click();
  const trimStart = first.getByRole('textbox', { name: 'Trim start time' });
  await trimStart.fill('00:00.50');
  await trimStart.press('Enter');
  await first.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('checkbox', { name: 'Enable crossfade' }).check();
  const crossfadeValue = page.getByRole('textbox', { name: 'Crossfade duration value' });
  await crossfadeValue.fill('1.25');
  await crossfadeValue.press('Enter');
  await page.getByRole('combobox', { name: 'Export format' }).selectOption('audio-mp3');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Round-trip.mixproj');
  const projectPath = await download.path();
  if (!projectPath) throw new Error('project download had no file');
  const projectBytes = await readFile(projectPath);
  expect(projectBytes.toString('ascii', 0, 9)).toBe('MIXPROJv2');

  const autosaved = () => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('media-mixer');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const item = db.transaction('projects').objectStore('projects').get('current');
      item.onerror = () => reject(item.error);
      item.onsuccess = () => {
        const saved = item.result;
        db.close();
        resolve(
          saved?.clips?.length === 2 &&
          saved.crossfadeSeconds === 1.25 &&
          saved.outputFormat === 'audio-mp3',
        );
      };
    };
  }));
  await expect.poll(autosaved, { timeout: 10_000 }).toBe(true);

  // Change the live settings, then reopen the saved file from disk.
  await page.getByRole('textbox', { name: 'Project name' }).fill('Wrong name');
  await page.getByRole('checkbox', { name: 'Enable crossfade' }).uncheck();
  await page.getByRole('combobox', { name: 'Export format' }).selectOption('video');
  await page.locator('input[accept=".mixproj"]').setInputFiles(projectPath);

  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Round trip');
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Merge 2 clips' })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: 'Enable crossfade' })).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Crossfade duration value' })).toHaveValue('1.25');
  await expect(page.getByRole('combobox', { name: 'Export format' })).toHaveValue('audio-mp3');

  const restoredFirst = page.locator('ol > li').first();
  await restoredFirst.getByRole('button', { name: /trim/ }).click();
  await expect(restoredFirst.getByRole('textbox', { name: 'Trim start time' })).toHaveValue('00:00.50');
});

test('offers crossfades and audio export only for video jobs', async ({ page }) => {
  await page.goto('/');
  const picker = page.locator('input[accept="video/*,audio/*"]').first();
  await picker.setInputFiles([fixture('seg1.mp4'), fixture('seg2.mp4')]);
  await expect(page.getByRole('checkbox', { name: 'Enable crossfade' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Export format' })).toBeVisible();

  await page.getByRole('checkbox', { name: 'Enable crossfade' }).check();
  const value = page.getByRole('textbox', { name: 'Crossfade duration value' });
  const slider = page.getByRole('slider', { name: 'Crossfade duration' });
  await value.fill('0.75s');
  await value.press('Enter');
  await expect(slider).toHaveValue('0.75');
  await expect(value).toHaveValue('0.75');

  await value.fill('00:00.40');
  await value.press('Enter');
  await expect(slider).toHaveValue('0.4');

  await value.fill('9');
  await value.press('Enter');
  await expect(slider).toHaveValue('2');
  await expect(value).toHaveValue('2.00');

  await page.getByRole('button', { name: 'Clear all' }).click();
  await picker.setInputFiles([fixture('aseg1.m4a'), fixture('aseg2.m4a')]);
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Enable crossfade' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Export format' })).toHaveCount(0);
});

test('merges videos with a picture and sound crossfade', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.locator('input[accept="video/*,audio/*"]').first().setInputFiles([
    fixture('seg1.mp4'),
    fixture('seg2.mp4'),
  ]);
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Enable crossfade' }).check();
  await expect(page.getByRole('slider', { name: 'Crossfade duration' })).toHaveValue('0.5');
  await expect(page.getByText(/after overlaps/)).toBeVisible();

  await page.getByRole('button', { name: 'Merge 2 clips' }).click();
  await expect(page.getByText(/0\.50 s video and audio crossfades/)).toBeVisible({ timeout: 60_000 });

  const link = page.getByRole('link', { name: 'Download' });
  await expect(link).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await link.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  const bytes = await readFile(await download.path());
  assert.ok(bytes.length > 100);
  assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
  const probe = await probeFile(new File([bytes], 'crossfade.mp4'));
  assert.ok(probe.ok, probe.ok ? undefined : probe.reason);
  if (probe.ok) expect(Math.abs(probe.clip.duration - 5.52)).toBeLessThan(0.3);
});

test('exports a video merge as a real MP3 file', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.locator('input[accept="video/*,audio/*"]').first().setInputFiles([
    fixture('seg1.mp4'),
    fixture('seg2.mp4'),
  ]);
  await expect(page.getByRole('heading', { name: /Clips \(2\)/ })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Enable crossfade' }).check();
  await page.getByRole('combobox', { name: 'Export format' }).selectOption('audio-mp3');

  await page.getByRole('button', { name: 'Merge 2 clips' }).click();
  await expect(page.getByText(/into one MP3/)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('audio[src]')).toBeVisible();
  await expect(page.locator('video[src]')).toHaveCount(0);

  const link = page.getByRole('link', { name: 'Download' });
  const downloadPromise = page.waitForEvent('download');
  await link.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.mp3$/);
  const bytes = await readFile(await download.path());
  assert.ok(bytes.length > 100);
  // MP3 starts with an ID3 tag or an MPEG frame sync.
  const isMp3 = bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  assert.ok(isMp3, 'expected a valid MP3 header');
  const probe = await probeFile(new File([bytes], 'soundtrack.mp3'));
  assert.ok(probe.ok, probe.ok ? undefined : probe.reason);
  if (probe.ok) expect(Math.abs(probe.clip.duration - 5.52)).toBeLessThan(0.4);
});
