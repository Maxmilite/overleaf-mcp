import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { convertImage, targetPathFor } from '../src/image.mjs';

// Build RGBA by hand: sharp's `create` background wants floats and has changed
// shape between majors, while a raw buffer means the same thing everywhere.
const png = async ({ r, g, b, a }) => {
  const width = 240;
  const height = 180;
  const raw = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    raw[i * 4] = r;
    raw[i * 4 + 1] = g;
    raw[i * 4 + 2] = b;
    raw[i * 4 + 3] = a;
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

test('targetPathFor swaps the extension and keeps the directory', () => {
  assert.equal(targetPathFor('figures/teaser.png', 'jpeg'), 'figures/teaser.jpg');
  assert.equal(targetPathFor('figures/teaser.PNG', 'jpeg'), 'figures/teaser.jpg');
  assert.equal(targetPathFor('a.b/c.d.png', 'webp'), 'a.b/c.d.webp');
  assert.equal(targetPathFor('no-extension', 'png'), 'no-extension.png');
  assert.throws(() => targetPathFor('a.png', 'gif'), /unsupported format/);
});

test('transparent png flattened onto white, never onto black', async () => {
  const source = await png({ r: 255, g: 0, b: 0, a: 128 });
  const { buffer, sourceHadAlpha, format } = await convertImage(source, { format: 'jpeg', quality: 95, background: '#ffffff' });

  assert.equal(format, 'jpeg');
  assert.equal(sourceHadAlpha, true, 'the source carried transparency');

  // A half-transparent red over white is pink: r=255, g/b≈128. Over black it would be dark red.
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = [data[0], data[1], data[2]];
  assert.ok(info.channels === 3, 'three channels, no alpha');
  assert.ok(r > 200, `red channel stays high (${r})`);
  assert.ok(g > 90 && g < 175, `green channel is the white blend, not black (${g})`);
  assert.ok(b > 90 && b < 175, `blue channel is the white blend, not black (${b})`);
});

test('rejects a format it cannot write', async () => {
  const source = await png({ r: 0, g: 0, b: 0, a: 255 });
  await assert.rejects(() => convertImage(source, { format: 'tiff' }), /unsupported format/);
});

test('garbage input fails loudly instead of writing an empty file', async () => {
  await assert.rejects(() => convertImage(Buffer.from('not an image at all'), { format: 'jpeg' }));
});

test('a photographic png really does get smaller as jpeg', async () => {
  // Noise compresses badly as PNG and well as JPEG, the same shape as a photo.
  // A synthetic pattern would alias into something PNG can compress, which is
  // exactly the trap this test is meant to avoid.
  const raw = randomBytes(400 * 300 * 3);
  const source = await sharp(raw, { raw: { width: 400, height: 300, channels: 3 } }).png().toBuffer();

  const { buffer } = await convertImage(source, { format: 'jpeg', quality: 82 });
  assert.ok(buffer.length < source.length, `${buffer.length} < ${source.length}`);
});
