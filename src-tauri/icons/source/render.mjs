// Renders icon.svg to a 1024×1024 transparent PNG via headless Chromium.
// Usage: node src-tauri/icons/source/render.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.goto('file://' + path.join(dir, 'icon.svg'));
await page.screenshot({
  path: path.join(dir, 'icon-1024.png'),
  omitBackground: true,
});
await browser.close();
console.log('wrote', path.join(dir, 'icon-1024.png'));
