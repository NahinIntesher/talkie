const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const sharp = require(require.resolve('sharp', { paths: [path.join(__dirname, '..', '..')] }));
const dir = path.join(__dirname, '..', '..', 'assets', 'brand', 'talkie', 'colors');
const fonts = ['C:/Windows/Fonts', path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Windows/Fonts')].find((d) => fs.existsSync(path.join(d, 'Quicksand-Bold.ttf')));
const font = opentype.loadSync(path.join(fonts, 'Quicksand-SemiBold.ttf'));
const themes = [['cyan', 'Cyan'], ['purple', 'Purple'], ['teal', 'Teal'], ['gold', 'Gold'], ['firoza', 'Firoza']];
const r = (f, w, h) => sharp(path.join(dir, f), { density: 600 }).resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const label = (text) => {
  const p = font.getPath(text, 0, 0, 34);
  const b = p.getBoundingBox();
  const w = Math.ceil(b.x2 - b.x1) + 4, h = Math.ceil(b.y2 - b.y1) + 4;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path transform="translate(${2 - b.x1} ${2 - b.y1})" d="${p.toPathData(2)}" fill="#475569"/></svg>`);
};
(async () => {
  const col = 340, W = 40 + themes.length * col, H = 760;
  const layers = [];
  for (const [i, [key, name]] of themes.entries()) {
    const x = 40 + i * col;
    layers.push({ input: await r(`${key}/talkie-icon.svg`, 280, 280), left: x + 10, top: 50 });
    const lab = await sharp(label(name)).png().toBuffer();
    const meta = await sharp(lab).metadata();
    layers.push({ input: lab, left: x + 150 - Math.round(meta.width / 2), top: 360 });
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" rx="24" fill="#fff"/></svg>`), left: x, top: 430 });
    layers.push({ input: await r(`${key}/talkie-logo.svg`, 260, 110), left: x + 20, top: 460 });
    layers.push({ input: await r(`${key}/talkie-logo-bn.svg`, 230, 100), left: x + 20, top: 590 });
  }
  await sharp({ create: { width: W, height: H, channels: 4, background: '#EEF0F6' } }).composite(layers).png().toFile(path.join(dir, 'talkie-colors-sheet.png'));
  console.log('ok');
})();
