/**
 * Write the user's chosen accent into the CSS token layer.
 *
 * Three tokens move together and must never drift apart, which is why this is
 * one function called from both startup (main.js) and the Settings picker
 * (settings.js) rather than duplicated parsing in each:
 *   --accent-blue  the colour itself
 *   --accent-rgb   the same colour as an "r, g, b" triple, for rgba(..., alpha)
 *   --accent-ink   the text/icon colour that sits ON the accent
 *
 * --accent-ink is derived, not fixed, because the accent is arbitrary. A hard
 * `color: white` on the primary button is 1.9:1 against the default #5ec6ff —
 * a real WCAG failure that flips to fine only if the user happens to pick a
 * dark accent. We measure both candidates and take the higher contrast, so a
 * pale accent gets near-black ink and a deep one gets white.
 */
window.applyAccentColor = function (accentColor) {
    const hex = String(accentColor || '').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;

    const root = document.documentElement;
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    // WCAG relative luminance.
    const channel = (c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const lum = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    // Contrast against white (lum 1) vs against our dark ink (#06222f).
    const DARK_INK = '#06222f';
    const DARK_INK_LUM = 0.0166;
    const vsWhite = 1.05 / (lum + 0.05);
    const vsDark = (lum + 0.05) / (DARK_INK_LUM + 0.05);

    root.style.setProperty('--accent-blue', '#' + hex);
    root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    root.style.setProperty('--accent-ink', vsDark >= vsWhite ? DARK_INK : '#ffffff');
    return true;
};
