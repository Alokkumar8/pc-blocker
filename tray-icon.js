const { nativeImage } = require('electron');

/**
 * Generates a crisp 16x16 BGRA bitmap icon for the Windows System Tray.
 * Uses pure black (#000000) background with terminal green (#00FF41) border and prompt glyph.
 * @param {boolean} isLocked Whether daily tasks are locked/committed
 * @returns {Electron.NativeImage}
 */
function createTrayIcon(isLocked = true) {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);

  // Colors in BGRA format (Windows little-endian bitmap order)
  const black = [0x00, 0x00, 0x00, 0xff]; // #000000
  const green = [0x41, 0xff, 0x00, 0xff]; // #00FF41 (terminal green)
  const amber = [0x00, 0xb0, 0xff, 0xff]; // #FFB000 (unlocked warning accent)
  const fg = isLocked ? green : amber;

  const setPixel = (x, y, color) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (y * size + x) * 4;
    buffer[idx] = color[0];
    buffer[idx + 1] = color[1];
    buffer[idx + 2] = color[2];
    buffer[idx + 3] = color[3];
  };

  // Fill background with pitch black
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      setPixel(x, y, black);
    }
  }

  // Outer 1px border (inset by 1px for crispness)
  for (let i = 1; i < size - 1; i++) {
    setPixel(i, 1, fg);
    setPixel(i, size - 2, fg);
    setPixel(1, i, fg);
    setPixel(size - 2, i, fg);
  }

  // Draw terminal chevron '>' on the left (x: 4..7, y: 5..11)
  setPixel(4, 5, fg);
  setPixel(5, 5, fg);
  setPixel(5, 6, fg);
  setPixel(6, 6, fg);
  setPixel(6, 7, fg);
  setPixel(7, 7, fg);
  setPixel(7, 8, fg);
  setPixel(6, 8, fg);
  setPixel(6, 9, fg);
  setPixel(5, 9, fg);
  setPixel(5, 10, fg);
  setPixel(4, 10, fg);

  // Draw block cursor / underscore '_' on the right (x: 9..12, y: 10..11)
  for (let x = 9; x <= 12; x++) {
    setPixel(x, 10, fg);
    setPixel(x, 11, fg);
  }

  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

module.exports = { createTrayIcon };

