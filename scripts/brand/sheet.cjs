const path = require('path');
const sharp = require(require.resolve('sharp', { paths: [path.join(__dirname, '..', '..')] }));
const dir = path.join(__dirname, '..', '..', 'assets', 'brand', 'talkie');
const r = (f, w, h) => sharp(path.join(dir, f), { density: 600 }).resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const panel = (w, h, color) => sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer();
(async () => {
  const W = 1800, H = 1240;
  const layers = [];
  // Row 1: app icon large + light panel with logos
  layers.push({ input: await r('talkie-icon.svg', 440, 440), left: 60, top: 60 });
  layers.push({ input: await panel(1220, 440, '#FFFFFF'), left: 540, top: 60 });
  layers.push({ input: await r('talkie-logo.svg', 700, 190), left: 640, top: 90 });
  layers.push({ input: await r('talkie-logo-bn.svg', 700, 190), left: 640, top: 290 });
  // Row 2: dark panel + brand panel
  layers.push({ input: await panel(840, 320, '#0F172A'), left: 60, top: 540 });
  layers.push({ input: await r('talkie-logo-white.svg', 640, 200), left: 160, top: 600 });
  layers.push({ input: await panel(880, 320, '#6D28D9'), left: 920, top: 540 });
  layers.push({ input: await r('talkie-logo-bn-white.svg', 640, 200), left: 1040, top: 600 });
  // Row 3: small sizes on light and on a phone-like dark home screen
  layers.push({ input: await panel(1740, 300, '#FFFFFF'), left: 60, top: 900 });
  let x = 120;
  for (const s of [16, 24, 32, 48, 64, 96, 128]) {
    layers.push({ input: await r(s <= 64 ? 'talkie-favicon.svg' : 'talkie-icon.svg', s, s), left: x, top: 1050 - Math.round(s / 2) });
    x += s + 60;
  }
  layers.push({ input: await panel(560, 240, '#111827'), left: 1180, top: 930 });
  for (const [i, s] of [[0, 112], [1, 112], [2, 112]]) {
    const f = ['talkie-icon.svg', 'talkie-mark-black.svg', 'talkie-mark.svg'][i];
    const bg = i === 1 ? await panel(112, 112, '#F9FAFB') : null;
    if (bg) layers.push({ input: bg, left: 1230 + i * 170, top: 994 });
    layers.push({ input: await r(f, s, s), left: 1230 + i * 170, top: 994 });
  }
  await sharp({ create: { width: W, height: H, channels: 4, background: '#EEF0F6' } }).composite(layers).png().toFile(path.join(dir, 'talkie-brand-sheet.png'));
  console.log('sheet ok');
})();
