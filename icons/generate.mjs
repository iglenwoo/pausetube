// Generates public/icons/icon16.png, icon48.png, icon128.png from icon.svg
// Run: pnpm icons

import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(__dirname, 'icon.svg'), 'utf8');

for (const size of [16, 48, 128]) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render().asPng();
  writeFileSync(join(__dirname, '..', 'public', 'icons', `icon${size}.png`), png);
  console.log(`icon${size}.png written`);
}
