// Assembles docs/assets/hero.gif from the frames captured by stage-hero.mjs
// (order and per-frame delays come from frames/frames.json). gifenc writes
// every frame in full, so gifsicle then does the inter-frame optimization
// that keeps a ~100-frame GIF shippable.
//
// gifenc, pngjs, and gifsicle are not project dependencies; grab them
// transiently:
//
//   npm install --no-save gifenc pngjs gifsicle
//   node docs/assets/source/encode-hero.mjs
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
import gifsicle from 'gifsicle';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'frames', 'frames.json'), 'utf8'));

// 2x box downscale: frames are captured at deviceScaleFactor 2 (2200x1480),
// the GIF ships at the app's native 1100x740.
function downscale2x(png) {
  const w = png.width / 2;
  const h = png.height / 2;
  const out = new Uint8ClampedArray(w * h * 4);
  const src = png.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        const i = (sy, sx) => (sy * png.width + sx) * 4 + c;
        out[(y * w + x) * 4 + c] =
          (src[i(2 * y, 2 * x)] +
            src[i(2 * y, 2 * x + 1)] +
            src[i(2 * y + 1, 2 * x)] +
            src[i(2 * y + 1, 2 * x + 1)]) /
          4;
      }
    }
  }
  return { data: out, width: w, height: h };
}

const gif = GIFEncoder();
for (const [n, { file, delay }] of manifest.entries()) {
  const png = PNG.sync.read(fs.readFileSync(path.join(HERE, 'frames', file)));
  const { data, width, height } = downscale2x(png);
  const palette = quantize(data, 256);
  gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay });
  if ((n + 1) % 20 === 0 || n === manifest.length - 1) {
    console.log(`${n + 1}/${manifest.length} frames encoded`);
  }
}
gif.finish();

const raw = path.join(HERE, 'frames', 'hero-raw.gif');
const out = path.join(HERE, '..', 'hero.gif');
fs.writeFileSync(raw, gif.bytes());
console.log('raw gif:', (fs.statSync(raw).size / 1048576).toFixed(1), 'MB; optimizing…');
execFileSync(gifsicle, ['-O3', '--lossy=40', '-o', out, raw]);

const last = manifest[manifest.length - 1].file;
fs.copyFileSync(path.join(HERE, 'frames', last), path.join(HERE, '..', 'hero.png'));
console.log('hero.gif:', (fs.statSync(out).size / 1048576).toFixed(1), 'MB; hero.png updated');
