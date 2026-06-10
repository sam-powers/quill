// Assembles docs/assets/hero.gif from the frames captured by stage-hero.mjs.
// gifenc and pngjs are not project dependencies; grab them transiently:
//
//   npm install --no-save gifenc pngjs
//   node docs/assets/source/encode-hero.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const FRAMES = [
  { file: 't1.png', delay: 2000 },
  { file: 't2.png', delay: 1800 },
  { file: 'a1.png', delay: 1800 },
  { file: 'a2.png', delay: 1500 },
  { file: 'a3.png', delay: 3600 },
  { file: 'a4.png', delay: 1500 },
  { file: 'a5.png', delay: 1300 },
  { file: 'a6.png', delay: 5000 },
];

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
for (const { file, delay } of FRAMES) {
  const png = PNG.sync.read(fs.readFileSync(path.join(HERE, 'frames', file)));
  const { data, width, height } = downscale2x(png);
  const palette = quantize(data, 256);
  gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay });
  console.log(file, 'encoded');
}
gif.finish();

const out = path.join(HERE, '..', 'hero.gif');
fs.writeFileSync(out, gif.bytes());
fs.copyFileSync(path.join(HERE, 'frames', 'a6.png'), path.join(HERE, '..', 'hero.png'));
console.log('hero.gif:', (fs.statSync(out).size / 1024).toFixed(0), 'KB; hero.png updated');
