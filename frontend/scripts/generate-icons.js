// Generates PWA icons (192x192 and 512x512 PNG) using pngjs (pure JS, no canvas needed)
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outputDir, { recursive: true });

// Loyal Mobile theme: blue background (#2563eb) with a white "L" phone glyph
const COLORS = {
  bg: [37, 99, 235],        // #2563eb
  bgDark: [29, 78, 216],    // #1d4ed8 (gradient bottom)
  white: [255, 255, 255],
  accent: [96, 165, 250]    // #60a5fa
};

function createIcon(size) {
  const png = new PNG({ width: size, height: size });
  const cx = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cx;
      // Soft rounded-square background
      const radius = size * 0.22;
      const dist = Math.max(Math.abs(dx) - (cx - radius), Math.abs(dy) - (cx - radius), 0);
      const edge = dist - radius;
      let alpha = 1;
      if (edge > 0) alpha = 0;
      else if (edge > -3) alpha = 1 + edge / 3;

      // Vertical gradient
      const t = y / size;
      const r = Math.round(COLORS.bg[0] + (COLORS.bgDark[0] - COLORS.bg[0]) * t);
      const g = Math.round(COLORS.bg[1] + (COLORS.bgDark[1] - COLORS.bg[1]) * t);
      const b = Math.round(COLORS.bg[2] + (COLORS.bgDark[2] - COLORS.bg[2]) * t);

      const idx = (size * y + x) << 2;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = Math.round(255 * alpha);
    }
  }

  // Draw a simple white smartphone rounded-rect glyph in the center
  const phoneW = size * 0.44;
  const phoneH = size * 0.66;
  const phoneX = cx - phoneW / 2;
  const phoneY = cx - phoneH / 2;
  const cornerRadius = phoneW * 0.18;
  const borderW = Math.max(2, size * 0.045);

  const inRoundedRect = (px, py, rx, ry, rw, rh, rad) => {
    // Inside the border region?
    const insideOuter = px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
    const insideInner = px >= rx + borderW && px <= rx + rw - borderW && py >= ry + borderW && py <= ry + rh - borderW;
    if (!insideOuter) return false;
    if (insideInner) return false; // only the border ring
    return true;
  };

  const inRoundedCorner = (px, py, rx, ry, rad) => {
    const dx = px - rx;
    const dy = py - ry;
    return dx * dx + dy * dy <= rad * rad;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const insideOuter = inRoundedRect(px, py, phoneX, phoneY, phoneW, phoneH, cornerRadius) ||
        (px < phoneX + cornerRadius && py < phoneY + cornerRadius && inRoundedCorner(px, py, phoneX + cornerRadius, phoneY + cornerRadius, cornerRadius)) ||
        (px > phoneX + phoneW - cornerRadius && py < phoneY + cornerRadius && inRoundedCorner(px, py, phoneX + phoneW - cornerRadius, phoneY + cornerRadius, cornerRadius)) ||
        (px < phoneX + cornerRadius && py > phoneY + phoneH - cornerRadius && inRoundedCorner(px, py, phoneX + cornerRadius, phoneY + phoneH - cornerRadius, cornerRadius)) ||
        (px > phoneX + phoneW - cornerRadius && py > phoneY + phoneH - cornerRadius && inRoundedCorner(px, py, phoneX + phoneW - cornerRadius, phoneY + phoneH - cornerRadius, cornerRadius));

      if (insideOuter) {
        const idx = (size * y + x) << 2;
        // Anti-alias border slightly
        const insideInner = px >= phoneX + borderW && px <= phoneX + phoneW - borderW && py >= phoneY + borderW && py <= phoneY + phoneH - borderW;
        const idxInner = ((phoneX + borderW + 1 < px && px < phoneX + phoneW - borderW - 1 && phoneY + borderW + 1 < py && py < phoneY + phoneH - borderW - 1));
        if (!idxInner) {
          const blend = 0.9;
          png.data[idx] = Math.round(COLORS.white[0] * blend + png.data[idx] * (1 - blend));
          png.data[idx + 1] = Math.round(COLORS.white[1] * blend + png.data[idx + 1] * (1 - blend));
          png.data[idx + 2] = Math.round(COLORS.white[2] * blend + png.data[idx + 2] * (1 - blend));
        }
      }
    }
  }

  // Draw speaker line at top and home button at bottom
  const speakerW = size * 0.16;
  const speakerH = Math.max(2, size * 0.025);
  const speakerY = phoneY + phoneH * 0.12;
  for (let y = Math.floor(speakerY); y < Math.floor(speakerY + speakerH); y++) {
    for (let x = Math.floor(cx - speakerW / 2); x < Math.floor(cx + speakerW / 2); x++) {
      if (x >= 0 && x < size && y >= 0 && y < size) {
        const idx = (size * y + x) << 2;
        png.data[idx] = COLORS.white[0];
        png.data[idx + 1] = COLORS.white[1];
        png.data[idx + 2] = COLORS.white[2];
      }
    }
  }

  const homeBtnW = size * 0.14;
  const homeBtnH = Math.max(2, size * 0.025);
  const homeY = phoneY + phoneH * 0.84;
  for (let y = Math.floor(homeY); y < Math.floor(homeY + homeBtnH); y++) {
    for (let x = Math.floor(cx - homeBtnW / 2); x < Math.floor(cx + homeBtnW / 2); x++) {
      if (x >= 0 && x < size && y >= 0 && y < size) {
        const idx = (size * y + x) << 2;
        png.data[idx] = COLORS.white[0];
        png.data[idx + 1] = COLORS.white[1];
        png.data[idx + 2] = COLORS.white[2];
      }
    }
  }

  return PNG.sync.write(png);
}

for (const size of [192, 512]) {
  const buffer = createIcon(size);
  const file = path.join(outputDir, `icon-${size}.png`);
  fs.writeFileSync(file, buffer);
  console.log(`Generated ${file} (${size}x${size})`);
}

// Also generate a favicon-32.png for browsers that don't support SVG
const favicon32 = createIcon(32);
fs.writeFileSync(path.join(outputDir, 'icon-32.png'), favicon32);
console.log(`Generated ${path.join(outputDir, 'icon-32.png')} (32x32)`);

console.log('All icons generated successfully.');