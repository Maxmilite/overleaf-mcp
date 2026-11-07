import sharp from 'sharp';

/**
 * Image transcoding.
 *
 * This is the one place the server does real work on bytes, because there is no
 * alternative: a model talking to a remote MCP server cannot decode a PNG and
 * re-encode it as JPEG, and shuttling a paper's figures through base64 to do it
 * client-side is neither reliable nor affordable.
 */

export const SUPPORTED_FORMATS = { jpeg: '.jpg', png: '.png', webp: '.webp' };
export const SUPPORTED_INPUT = /\.(png|jpe?g|webp|tiff?|bmp|gif|avif)$/i;

export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/** Output path for a source file and a target format: `figures/a.png` → `figures/a.jpg`. */
export function targetPathFor(filePath, format) {
  const ext = SUPPORTED_FORMATS[format];
  if (!ext) throw new Error(`unsupported format "${format}" (use ${Object.keys(SUPPORTED_FORMATS).join(', ')})`);
  return filePath.replace(/\.[^./\\]+$/, '') + ext;
}

/**
 * Transcode one image.
 *
 * Alpha has no representation in JPEG, so it is flattened onto a background
 * first — sharp would otherwise composite onto black and quietly turn a
 * transparent figure into something on a black page.
 */
export async function convertImage(buffer, { format, quality, background = '#ffffff' } = {}) {
  if (!SUPPORTED_FORMATS[format]) {
    throw new Error(`unsupported format "${format}" (use ${Object.keys(SUPPORTED_FORMATS).join(', ')})`);
  }

  let pipeline = sharp(buffer, { failOn: 'none', limitInputPixels: 250_000_000 });
  const meta = await pipeline.metadata();
  if (meta.pages && meta.pages > 1) {
    throw new Error('animated images are not supported');
  }

  if (format === 'jpeg') {
    pipeline = pipeline.flatten({ background });
  }

  const q = Math.max(1, Math.min(100, Math.round(quality ?? 82)));
  pipeline =
    format === 'jpeg'
      ? pipeline.jpeg({ quality: q, mozjpeg: true })
      : format === 'png'
        ? pipeline.png({ compressionLevel: 9, palette: true })
        : pipeline.webp({ quality: q });

  const out = await pipeline.toBuffer();
  return {
    buffer: out,
    width: meta.width,
    height: meta.height,
    format,
    sourceHadAlpha: Boolean(meta.hasAlpha),
  };
}
