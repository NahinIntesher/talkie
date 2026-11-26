// Generates every Talkie logo file from one geometry: assets/brand/talkie (all variants and colours), the Android launcher,
// notification and in-app icons, and the web favicon/app icons. Run: npm run brand  (main colour: MAIN_KEY below).
// Text is converted to outlines (Quicksand / Baloo Da 2 must be installed on this computer).
// Text is converted to outlines, so the lockups look the same on every computer.
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const sharp = require(require.resolve('sharp', { paths: [path.join(__dirname, '..', '..')] }));

const out = path.join(__dirname, '..', '..', 'assets', 'brand', 'talkie');
const fonts = ['C:/Windows/Fonts', path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Windows/Fonts')].find((dir) => fs.existsSync(path.join(dir, 'Quicksand-Bold.ttf')));
const quicksand = opentype.loadSync(path.join(fonts, 'Quicksand-Bold.ttf'));
const baloo = opentype.loadSync(path.join(fonts, 'BalooDa2-Bold.ttf'));

// Master geometry (512 × 512 artboard), shared by every variant.
// A perfectly round bubble (centre C, radius R) with a tail growing out of its lower left.
// Sizes are proportions of the circle, so the whole mark stays balanced if R changes.
const C = { x: 256, y: 240 };
const R = 152;
const at = (deg) => [C.x + R * Math.cos((deg * Math.PI) / 180), C.y + R * Math.sin((deg * Math.PI) / 180)].map((v) => +v.toFixed(2));
const [p1x, p1y] = at(140); // tail leaves the circle here…
const [p2x, p2y] = at(117); // …and joins it again here
const TIP = { x: +(C.x - 0.833 * R).toFixed(2), y: +(C.y + 1.106 * R).toFixed(2) }; // a short tail, pointing down and left
const BUBBLE = [
  `M${p1x} ${p1y}`,
  `A${R} ${R} 0 1 1 ${p2x} ${p2y}`, // the full circle, the long way round
  `C${p2x - 14} ${p2y + 8} ${TIP.x + 26} ${TIP.y - 2} ${TIP.x + 6} ${TIP.y + 1}`, // underside of the tail
  `Q${TIP.x - 8} ${TIP.y + 3} ${TIP.x - 5} ${TIP.y - 10}`, // rounded tip
  `C${TIP.x - 1} ${TIP.y - 26} ${p1x - 2} ${p1y + 24} ${p1x} ${p1y}z`, // back up into the circle
].join('');
// The T, centred on the circle.
const T_BOX = (() => {
  const w = 1.14 * R; // crossbar width
  const h = 1.1 * R; // overall height
  const th = 0.36 * R; // stroke thickness
  return { w, h, th, left: C.x - w / 2, top: C.y - h / 2 + 0.03 * R }; // a touch low: the crossbar makes a T look top-heavy
})();
const T = (() => {
  const { w, h, th, left, top } = T_BOX;
  const r = th / 2;
  const n = (v) => +v.toFixed(2);
  return [
    `M${n(left + r)} ${n(top)}`,
    `H${n(left + w - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(left + w - r)} ${n(top + th)}`,
    `H${n(C.x + r)}`,
    `V${n(top + h - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(C.x - r)} ${n(top + h - r)}`,
    `V${n(top + th)}`,
    `H${n(left + r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(left + r)} ${n(top)}z`,
  ].join('');
})();
const BOUNDS = { x1: C.x - R, y1: C.y - R, x2: C.x + R, y2: TIP.y + 6 };
const BRAND = [['0', '#4F46E5'], ['.52', '#7C3AED'], ['1', '#C026D3']];
const stops = (list) => list.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
const MARK_BOX = { x: Math.floor(BOUNDS.x1 - 10), y: Math.floor(BOUNDS.y1 - 10), w: Math.ceil(BOUNDS.x2 - BOUNDS.x1 + 20), h: Math.ceil(BOUNDS.y2 - BOUNDS.y1 + 20) }; // with a little air

const write = (name, svg) => fs.writeFileSync(path.join(out, name), svg.trim() + '\n');

// 1. Mark on light backgrounds: brand-gradient bubble, white T.
const markDefs = `<linearGradient id="m" x1="${BOUNDS.x1}" y1="${BOUNDS.y1}" x2="${BOUNDS.x2}" y2="${BOUNDS.y2}" gradientUnits="userSpaceOnUse">${stops(BRAND)}</linearGradient>`;

// 0. App icon: brand tile, soft light, round white bubble with depth, gradient T.
write(
  'talkie-icon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Talkie</title><defs>
    <linearGradient id="bg" x1="64" y1="32" x2="448" y2="496" gradientUnits="userSpaceOnUse">${stops(BRAND)}</linearGradient>
    <radialGradient id="light" cx="120" cy="70" r="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="bubble" x1="0" y1="${BOUNDS.y1}" x2="0" y2="${BOUNDS.y2}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#EDE9FE"/></linearGradient>
    <linearGradient id="glyph" x1="${T_BOX.left}" y1="${T_BOX.top}" x2="${T_BOX.left + T_BOX.w}" y2="${T_BOX.top + T_BOX.h}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4F46E5"/><stop offset="1" stop-color="#A21CAF"/></linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#2E1065" flood-opacity=".38"/></filter>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <rect width="512" height="512" rx="116" fill="url(#light)"/>
  <path d="${BUBBLE}" fill="url(#bubble)" filter="url(#shadow)"/>
  <path d="${T}" fill="url(#glyph)"/></svg>`,
);
const mark = (dx = 0, dy = 0) => `<g transform="translate(${dx} ${dy})"><path d="${BUBBLE}" fill="url(#m)"/><path d="${T}" fill="#fff"/></g>`;
write('talkie-mark.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}"><title>Talkie</title><defs>${markDefs}</defs>${mark()}</svg>`);

// 2. Mark on dark or coloured backgrounds: white bubble with the T cut out.
const knockout = (fill, dx = 0, dy = 0) =>
  `<g transform="translate(${dx} ${dy})"><path fill-rule="evenodd" d="${BUBBLE} ${T}" fill="${fill}"/></g>`;
write('talkie-mark-white.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}"><title>Talkie</title>${knockout('#fff')}</svg>`);
write('talkie-mark-black.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}"><title>Talkie</title>${knockout('#111827')}</svg>`);

// 3. Favicon / tiny sizes: flat (no light, no shadow) and a slightly larger bubble so it stays clear at 16 px.
write(
  'talkie-favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Talkie</title><defs><linearGradient id="b" x1="64" y1="32" x2="448" y2="496" gradientUnits="userSpaceOnUse">${stops(BRAND)}</linearGradient></defs>
  <rect width="512" height="512" rx="116" fill="url(#b)"/>
  <g transform="translate(256 252) scale(1.06) translate(-256 -252)"><path d="${BUBBLE}" fill="#fff"/><path d="${T}" fill="url(#b)"/></g></svg>`,
);

// 4. Lockups: mark + name. Name is centred on the bubble body; letters are outlines.
function lockup(file, text, font, size, color, markSvg, defs = '', gap = 44, letterSpacing = 0) {
  const glyphs = font.getPath(text, 0, 0, size, { letterSpacing });
  const box = glyphs.getBoundingBox();
  const bodyCenter = C.y; // vertical centre of the round bubble
  const capCenter = (box.y1 + box.y2) / 2;
  const tx = MARK_BOX.x + MARK_BOX.w + gap - box.x1;
  const ty = bodyCenter - capCenter;
  const width = MARK_BOX.w + gap + (box.x2 - box.x1) + 24;
  const data = font.getPath(text, tx, ty, size, { letterSpacing }).toPathData(2);
  write(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${Math.ceil(width)} ${MARK_BOX.h}"><title>Talkie</title>${defs ? `<defs>${defs}</defs>` : ''}${markSvg}<path d="${data}" fill="${color}"/></svg>`,
  );
}
lockup('talkie-logo.svg', 'Talkie', quicksand, 196, '#1E1B4B', mark(), markDefs);
lockup('talkie-logo-white.svg', 'Talkie', quicksand, 196, '#FFFFFF', knockout('#fff'));
// opentype.js does not shape Bengali, so the pre-base vowel sign ি is placed before ক by hand (visual order).
// Reads "টকি" (Talkie).
const BN_VISUAL = 'ট' + 'ি' + 'ক';
lockup('talkie-logo-bn.svg', BN_VISUAL, baloo, 230, '#1E1B4B', mark(), markDefs);
lockup('talkie-logo-bn-white.svg', BN_VISUAL, baloo, 230, '#FFFFFF', knockout('#fff'));

// 4b. Colour editions. Each has its own three-shade gradient, a deeper shade for the T, a matching bubble tint,
// a shadow colour from the same family and an ink colour for the name.
const THEMES = {
  cyan: { name: 'Cyan', light: 0.24, stops: [['0', '#22D3EE'], ['.5', '#0891B2'], ['1', '#2563EB']], glyph: ['#0891B2', '#1D4ED8'], tint: '#E0F2FE', shadow: '#0C4A6E', ink: '#0C4A6E' },
  purple: { name: 'Purple', stops: BRAND, glyph: ['#4F46E5', '#A21CAF'], tint: '#EDE9FE', shadow: '#2E1065', ink: '#1E1B4B' },
  teal: { name: 'Teal', stops: [['0', '#2DD4BF'], ['.5', '#0D9488'], ['1', '#115E59']], glyph: ['#0D9488', '#134E4A'], tint: '#CCFBF1', shadow: '#042F2E', ink: '#134E4A' },
  gold: { name: 'Gold', light: 0.18, stops: [['0', '#FBBF24'], ['.5', '#F59E0B'], ['1', '#B45309']], glyph: ['#D97706', '#92400E'], tint: '#FEF3C7', shadow: '#451A03', ink: '#451A03' },
  firoza: { name: 'Firoza', light: 0.16, stops: [['0', '#34D3C6'], ['.55', '#14B8B0'], ['1', '#0891B2']], glyph: ['#0FA89F', '#0E7490'], tint: '#E6FFFB', shadow: '#134E4A', ink: '#0F3D3E' },
};

const iconFor = (t) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Talkie</title><defs>
    <linearGradient id="bg" x1="64" y1="32" x2="448" y2="496" gradientUnits="userSpaceOnUse">${stops(t.stops)}</linearGradient>
    <radialGradient id="light" cx="120" cy="70" r="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="${t.light ?? 0.3}"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="bubble" x1="0" y1="${BOUNDS.y1}" x2="0" y2="${BOUNDS.y2}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="${t.tint}"/></linearGradient>
    <linearGradient id="glyph" x1="${T_BOX.left}" y1="${T_BOX.top}" x2="${T_BOX.left + T_BOX.w}" y2="${T_BOX.top + T_BOX.h}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${t.glyph[0]}"/><stop offset="1" stop-color="${t.glyph[1]}"/></linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="${t.shadow}" flood-opacity=".38"/></filter>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <rect width="512" height="512" rx="116" fill="url(#light)"/>
  <path d="${BUBBLE}" fill="url(#bubble)" filter="url(#shadow)"/>
  <path d="${T}" fill="url(#glyph)"/></svg>`;

const faviconFor = (t) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Talkie</title><defs><linearGradient id="b" x1="64" y1="32" x2="448" y2="496" gradientUnits="userSpaceOnUse">${stops(t.stops)}</linearGradient><linearGradient id="g" x1="${T_BOX.left}" y1="${T_BOX.top}" x2="${T_BOX.left + T_BOX.w}" y2="${T_BOX.top + T_BOX.h}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${t.glyph[0]}"/><stop offset="1" stop-color="${t.glyph[1]}"/></linearGradient></defs>
  <rect width="512" height="512" rx="116" fill="url(#b)"/>
  <g transform="translate(256 252) scale(1.06) translate(-256 -252)"><path d="${BUBBLE}" fill="#fff"/><path d="${T}" fill="url(#g)"/></g></svg>`;

const themeMarkDefs = (t) => `<linearGradient id="m" x1="${BOUNDS.x1}" y1="${BOUNDS.y1}" x2="${BOUNDS.x2}" y2="${BOUNDS.y2}" gradientUnits="userSpaceOnUse">${stops(t.stops)}</linearGradient>`;

for (const [key, t] of Object.entries(THEMES)) {
  fs.mkdirSync(path.join(out, 'colors', key), { recursive: true });
  const at = (file) => `colors/${key}/${file}`;
  write(at('talkie-icon.svg'), iconFor(t));
  write(at('talkie-favicon.svg'), faviconFor(t));
  write(at('talkie-mark.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}"><title>Talkie</title><defs>${themeMarkDefs(t)}</defs>${mark()}</svg>`);
  lockup(at('talkie-logo.svg'), 'Talkie', quicksand, 196, t.ink, mark(), themeMarkDefs(t));
  lockup(at('talkie-logo-bn.svg'), BN_VISUAL, baloo, 230, t.ink, mark(), themeMarkDefs(t));
}

// 4c. The main colour: the root files (icon, favicon, mark, lockups) and everything the apps use.
const MAIN_KEY = 'gold';
const MAIN = THEMES[MAIN_KEY];
write('talkie-icon.svg', iconFor(MAIN));
write('talkie-favicon.svg', faviconFor(MAIN));
write('talkie-mark.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}"><title>Talkie</title><defs>${themeMarkDefs(MAIN)}</defs>${mark()}</svg>`);
lockup('talkie-logo.svg', 'Talkie', quicksand, 196, MAIN.ink, mark(), themeMarkDefs(MAIN));
lockup('talkie-logo-bn.svg', BN_VISUAL, baloo, 230, MAIN.ink, mark(), themeMarkDefs(MAIN));

// Android adaptive icon layers (108 × 108 dp canvas; launchers crop it to their own shape, keep art inside 66 dp).
const ADAPTIVE = (() => {
  const box = 50; // the mark fits in this many dp, centred (launchers show the middle 72 dp)
  const w = BOUNDS.x2 - BOUNDS.x1, h = BOUNDS.y2 - BOUNDS.y1;
  const scale = box / Math.max(w, h);
  const cx = (BOUNDS.x1 + BOUNDS.x2) / 2, cy = (BOUNDS.y1 + BOUNDS.y2) / 2;
  return `translate(54 54) scale(${scale.toFixed(5)}) translate(${-cx} ${-cy})`;
})();
write('android-background.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><defs>
  <linearGradient id="bg" x1="0" y1="0" x2="108" y2="108" gradientUnits="userSpaceOnUse">${stops(MAIN.stops)}</linearGradient>
  <radialGradient id="light" cx="24" cy="14" r="88" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="${MAIN.light ?? 0.3}"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs><rect width="108" height="108" fill="url(#bg)"/><rect width="108" height="108" fill="url(#light)"/></svg>`);
write('android-foreground.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><defs>
  <linearGradient id="bubble" x1="0" y1="${BOUNDS.y1}" x2="0" y2="${BOUNDS.y2}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="${MAIN.tint}"/></linearGradient>
  <linearGradient id="glyph" x1="${T_BOX.left}" y1="${T_BOX.top}" x2="${T_BOX.left + T_BOX.w}" y2="${T_BOX.top + T_BOX.h}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${MAIN.glyph[0]}"/><stop offset="1" stop-color="${MAIN.glyph[1]}"/></linearGradient>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="${MAIN.shadow}" flood-opacity=".34"/></filter>
  </defs><g transform="${ADAPTIVE}"><path d="${BUBBLE}" fill="url(#bubble)" filter="url(#shadow)"/><path d="${T}" fill="url(#glyph)"/></g></svg>`);
// Android 13+ themed icons and the status-bar notification icon are single-colour silhouettes.
write('android-monochrome.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><g transform="${ADAPTIVE}"><path fill-rule="evenodd" d="${BUBBLE} ${T}" fill="#fff"/></g></svg>`);
write('android-notification.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}"><path fill-rule="evenodd" d="${BUBBLE} ${T}" fill="#fff"/></svg>`);

// 5. PNG exports.
(async () => {
  const png = (svg, file, width, height = width) => sharp(path.join(out, svg), { density: 600 }).resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(out, 'png', file));
  fs.mkdirSync(path.join(out, 'png'), { recursive: true });
  await png('talkie-icon.svg', 'talkie-icon-1024.png', 1024);
  await png('talkie-icon.svg', 'talkie-icon-512.png', 512); // Google Play store icon
  await png('talkie-icon.svg', 'talkie-icon-192.png', 192);
  for (const size of [16, 32, 48, 64, 180]) await png('talkie-favicon.svg', `talkie-favicon-${size}.png`, size);
  await png('talkie-mark.svg', 'talkie-mark-512.png', 512, Math.round((512 * MARK_BOX.h) / MARK_BOX.w));
  await png('talkie-logo.svg', 'talkie-logo-1200.png', 1200, 360);
  await png('talkie-logo-white.svg', 'talkie-logo-white-1200.png', 1200, 360);
  await png('talkie-logo-bn.svg', 'talkie-logo-bn-1200.png', 1200, 360);
  for (const key of Object.keys(THEMES)) {
    fs.mkdirSync(path.join(out, 'colors', key, 'png'), { recursive: true });
    const at = (file) => `colors/${key}/${file}`;
    await png(at('talkie-icon.svg'), `../colors/${key}/png/talkie-icon-1024.png`, 1024);
    await png(at('talkie-icon.svg'), `../colors/${key}/png/talkie-icon-512.png`, 512);
    await png(at('talkie-logo.svg'), `../colors/${key}/png/talkie-logo-1200.png`, 1200, 360);
  }
  // Into the apps.
  const root = path.join(__dirname, '..', '..');
  const res = path.join(root, 'apps', 'mobile', 'android', 'app', 'src', 'main', 'res');
  const render = (svg, file, width, height = width) =>
    sharp(path.join(out, svg), { density: 600 }).resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(file);
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [density, k] of Object.entries(densities)) {
    const mip = path.join(res, `mipmap-${density}`);
    fs.mkdirSync(mip, { recursive: true });
    await render('talkie-icon.svg', path.join(mip, 'ic_launcher.png'), Math.round(48 * k)); // phones before Android 8
    await render('android-background.svg', path.join(mip, 'ic_launcher_background.png'), Math.round(108 * k));
    await render('android-foreground.svg', path.join(mip, 'ic_launcher_foreground.png'), Math.round(108 * k));
    await render('android-monochrome.svg', path.join(mip, 'ic_launcher_monochrome.png'), Math.round(108 * k));
    const drawable = path.join(res, `drawable-${density}`);
    fs.mkdirSync(drawable, { recursive: true });
    await render('android-notification.svg', path.join(drawable, 'ic_stat_talkie.png'), Math.round(24 * k));
  }
  fs.mkdirSync(path.join(res, 'mipmap-anydpi-v26'), { recursive: true });
  fs.writeFileSync(
    path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`,
  );
  // In-app logo (Flutter) and the web app.
  fs.mkdirSync(path.join(root, 'apps', 'mobile', 'assets', 'brand'), { recursive: true });
  await render('talkie-icon.svg', path.join(root, 'apps', 'mobile', 'assets', 'brand', 'talkie-icon.png'), 512);
  const pub = path.join(root, 'apps', 'web', 'public');
  fs.copyFileSync(path.join(out, 'talkie-favicon.svg'), path.join(pub, 'icon.svg'));
  await render('talkie-icon.svg', path.join(pub, 'icon-192.png'), 192);
  await render('talkie-icon.svg', path.join(pub, 'icon-512.png'), 512);
  await render('talkie-favicon.svg', path.join(pub, 'apple-touch-icon.png'), 180);
  console.log('brand files written to', out, '(main colour:', MAIN.name + ')');
})();
