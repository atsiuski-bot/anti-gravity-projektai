/**
 * One-off PWA asset generator (run manually, NOT part of the build).
 *
 *   npm i --no-save sharp && node scripts/generate-pwa-assets.cjs
 *   (sharp is intentionally NOT a committed dependency — it's only needed to regenerate these.)
 *
 * SINGLE SOURCE OF TRUTH: brand/logo.png — the transparent brand mark, kept OUT of public/ so the
 * heavy 1000px master never ships. EVERYTHING below is DERIVED from it, so swapping the logo is:
 * drop a new transparent brand/logo.png in place and re-run this script.
 *
 * Produces:
 *   0. public/logo-mark.png — a small transparent in-UI mark for <BrandMark> (the master is far too
 *      heavy to render at ≤80px / precache). This is the ONLY logo asset served in-app.
 *   1. Base app icons pwa-{192,512}x… — the mark trimmed + padded on a WHITE field, flattened to
 *      opaque (favicons + iOS apple-touch + Android `any` need no transparency; iOS composites a
 *      transparent icon onto BLACK). White matches the manifest background_color (#ffffff).
 *   2. Maskable icons pwa-…-maskable — the mark padded well inside the central 80% safe zone on the
 *      same white field, so Android adaptive launchers never clip it.
 *   3. iOS apple-touch-startup-image splash screens (theme background + a centered rounded app-icon
 *      chip) for the mainstream iPhone classes, in light AND dark, so the installed PWA shows a
 *      branded launch screen instead of a white/black flash.
 *
 * It also writes scripts/apple-splash-links.html — the exact <link> tags to paste into index.html.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const SRC_MARK = path.join(ROOT, 'brand', 'logo.png'); // transparent brand mark — source of truth (NOT shipped)
const SPLASH_DIR = path.join(PUB, 'splash');

// White field for every icon: matches the manifest background_color (#ffffff) so the iOS light
// splash blends seamlessly and the indigo mark always rides maximum-contrast white.
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

// iPhone device classes: [devicePxW, devicePxH, dpr]. Logical CSS px = devicePx / dpr. Portrait.
// Covers iPhone SE/8 through the iPhone 16 Pro Max line.
const DEVICES = [
  [750, 1334, 2],   // SE 2/3, 8, 7, 6s
  [828, 1792, 2],   // XR, 11
  [1125, 2436, 3],  // X, XS, 11 Pro, 12/13 mini
  [1170, 2532, 3],  // 12, 12 Pro, 13, 13 Pro, 14
  [1179, 2556, 3],  // 14 Pro, 15, 15 Pro, 16
  [1206, 2622, 3],  // 16 Pro
  [1242, 2688, 3],  // XS Max, 11 Pro Max
  [1284, 2778, 3],  // 12/13 Pro Max, 14 Plus
  [1290, 2796, 3],  // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [1320, 2868, 3],  // 16 Pro Max
];

const THEMES = {
  light: WHITE,                            // manifest background_color
  dark: { r: 14, g: 17, b: 23, alpha: 1 }, // --surface-base (dark) #0E1117
};

// The trimmed mark, reused by every icon. trim() drops the transparent border so the padding below
// is measured from the actual glyph, not from the source PNG's built-in whitespace.
async function trimmedMark() {
  return sharp(SRC_MARK).trim().png().toBuffer();
}

// Small TRANSPARENT in-UI mark for <BrandMark>'s <img> (it rides a white tile, so no bg here).
// 192 px tall is crisp at the largest in-app render (80 px @2× DPR) at a fraction of the master.
async function makeUiMark(mark) {
  const out = path.join(PUB, 'logo-mark.png');
  await sharp(mark).resize({ height: 192 }).png({ compressionLevel: 9 }).toFile(out);
  console.log('ui mark ->', path.relative(ROOT, out));
}

// Place `mark` fit inside `frac` of an N×N white square, centered, flattened to opaque white.
async function makeIcon(out, size, frac, mark) {
  const box = Math.round(size * frac);
  const inner = await sharp(mark).resize(box, box, { fit: 'inside' }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: WHITE } })
    .composite([{ input: inner, gravity: 'center' }])
    .flatten({ background: WHITE })
    .png()
    .toFile(out);
  console.log('icon ->', path.relative(ROOT, out));
}

async function makeSplash(w, h, theme) {
  // Use the generated WHITE base icon as the chip so the splash shows a crisp rounded app icon —
  // white on the dark theme, blended into the white light theme — the same look iOS gives a native
  // app icon. (Reading the opaque base icon, not the transparent mark, keeps dark-mode contrast.)
  const iconSize = Math.round(Math.min(w, h) * 0.38);
  const radius = Math.round(iconSize * 0.22);
  const mask = Buffer.from(
    `<svg width="${iconSize}" height="${iconSize}"><rect width="${iconSize}" height="${iconSize}" rx="${radius}" ry="${radius}"/></svg>`
  );
  const icon = await sharp(path.join(PUB, 'pwa-512x512.png'))
    .resize(iconSize, iconSize)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const out = path.join(SPLASH_DIR, `apple-splash-${w}-${h}-${theme}.png`);
  await sharp({ create: { width: w, height: h, channels: 4, background: THEMES[theme] } })
    .composite([{ input: icon, gravity: 'center' }])
    .png()
    .toFile(out);
}

function linkTag(w, h, dpr, theme) {
  const lw = Math.round(w / dpr);
  const lh = Math.round(h / dpr);
  const media =
    `screen and (device-width: ${lw}px) and (device-height: ${lh}px) ` +
    `and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait) ` +
    `and (prefers-color-scheme: ${theme})`;
  return `  <link rel="apple-touch-startup-image" media="${media}" href="/splash/apple-splash-${w}-${h}-${theme}.png" />`;
}

async function main() {
  fs.mkdirSync(SPLASH_DIR, { recursive: true });
  const mark = await trimmedMark();

  // Small transparent in-UI mark (the only logo asset served in-app).
  await makeUiMark(mark);

  // Base icons (opaque white). 78% leaves a calm margin — used by the favicon, apple-touch-icon
  // and the Android `any` icon. The 192 is downscaled identically (not from the 512) for crispness.
  await makeIcon(path.join(PUB, 'pwa-512x512.png'), 512, 0.78, mark);
  await makeIcon(path.join(PUB, 'pwa-192x192.png'), 192, 0.78, mark);
  // Maskable: 60% sits comfortably inside the central 80% safe zone so no adaptive launcher mask
  // (circle / squircle / teardrop) ever clips the glyph.
  await makeIcon(path.join(PUB, 'pwa-512x512-maskable.png'), 512, 0.60, mark);
  await makeIcon(path.join(PUB, 'pwa-192x192-maskable.png'), 192, 0.60, mark);

  const links = [];
  for (const [w, h, dpr] of DEVICES) {
    for (const theme of Object.keys(THEMES)) {
      await makeSplash(w, h, theme);
      links.push(linkTag(w, h, dpr, theme));
    }
  }
  console.log(`splash -> ${DEVICES.length * 2} files in public/splash/`);

  const snippet =
    '<!-- iOS standalone launch screens (apple-touch-startup-image). Generated by\n' +
    '     scripts/generate-pwa-assets.cjs — do not hand-edit; re-run the script to regenerate.\n' +
    '     Portrait only (the app is portrait-first); light + dark via prefers-color-scheme. -->\n' +
    links.join('\n') + '\n';
  fs.writeFileSync(path.join(__dirname, 'apple-splash-links.html'), snippet);
  console.log('wrote scripts/apple-splash-links.html');
}

main().catch((e) => { console.error(e); process.exit(1); });
