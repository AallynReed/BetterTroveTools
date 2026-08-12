"""GDI+ rendering for the in-game overlay (Windows only).

Turns a list of widget view-models into a 32-bit premultiplied-ARGB bitmap that
``utils.overlay_window`` hands to ``UpdateLayeredWindow``.

**Why this is drawn natively instead of in a WebView.** The overlay started as a
second WebView2 window and it could not be made see-through. Measured on a real
machine, every route produced an opaque window over the game: pywebview's
``transparent=True``, ``DwmExtendFrameIntoClientArea`` with a fully-extended
frame, a colour key on the page's own pixels, and a colour key on the hosting
Form's pixels. WebView2 renders through DirectComposition, so its pixels never
reach the layered window's redirection surface where DWM evaluates the colour
key -- the key silently matches nothing and only the uniform alpha applies,
dimming the entire screen. A per-pixel-alpha layered window has none of that
indirection: the alpha channel we draw IS what DWM composites, so empty regions
are genuinely transparent and genuinely click-through.

The palette and metrics below are the DESIGN.md tokens transcribed for GDI+.
They are duplicated from the CSS token layer because this renderer cannot read
CSS -- when a token changes in ``web/css/style.css``, it has to change here too.
That duplication is the price of not being able to use the web stack at all;
keeping the values in one clearly-labelled block is the mitigation.
"""
from __future__ import annotations

import sys

_IS_WINDOWS = sys.platform == "win32"

_gdi_ready = False
_gdi_error = None

if _IS_WINDOWS:
    try:
        import clr  # pythonnet, already a dependency via pywebview

        clr.AddReference("System.Drawing")
        from System import IntPtr
        from System.Drawing import (Bitmap, Color, Font, FontFamily, FontStyle,
                                    Graphics, GraphicsUnit, PointF, RectangleF,
                                    SizeF, SolidBrush, StringFormat)
        from System.Drawing import StringFormatFlags
        from System.Drawing.Drawing2D import GraphicsPath, SmoothingMode
        from System.Drawing.Imaging import PixelFormat
        from System.Drawing.Text import TextRenderingHint

        _gdi_ready = True
    except Exception as exc:  # pragma: no cover - depends on the host runtime
        _gdi_error = exc


# --- design tokens (mirrors web/css/style.css :root) ------------------------

INK = (224, 224, 224)          # --text-main
INK_MUTED = (163, 173, 194)    # --text-muted
INK_PLACEHOLDER = (125, 135, 152)
PANEL = (30, 30, 30)           # --bg-panel
HAIRLINE = (255, 255, 255, 26)  # ~10% white
SUCCESS = (74, 222, 128)
WARNING = (251, 191, 36)

RADIUS = 10                    # --radius-surface
PAD_X, PAD_Y = 12, 8           # --t-3 / --t-2
GAP = 4                        # --t-1
WIDGET_MIN_W = 132
WIDGET_MAX_W = 340

# Type roles, in pixels. The web scale is rem-based; these are the same six
# roles resolved at the app's 16px root so the overlay reads like the app.
FS_EYEBROW = 11   # micro, 800 weight, uppercase, 1px tracking
FS_LABEL = 13
FS_BODY = 14
FS_TITLE = 17     # h2
FS_HERO = 34      # display — the clock only


def available():
    return _gdi_ready


def unavailable_reason():
    return None if _gdi_ready else f"{type(_gdi_error).__name__}: {_gdi_error}" if _gdi_error else "not Windows"


def _color(rgb, alpha=255):
    if len(rgb) == 4:
        return Color.FromArgb(rgb[3], rgb[0], rgb[1], rgb[2])
    return Color.FromArgb(alpha, rgb[0], rgb[1], rgb[2])


def parse_hex(value, fallback=None):
    """'#a14200' / 'a14200' -> (r, g, b), or ``fallback``."""
    text = str(value or "").strip().lstrip("#")
    if len(text) != 6:
        return fallback
    try:
        return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
    except ValueError:
        return fallback


class _Fonts:
    """Lazily built font cache, keyed by (role, scale).

    Fonts are the one genuinely expensive object here, and the renderer rebuilds
    its bitmap once a second -- creating six fonts per frame would dominate the
    cost of the whole overlay.
    """

    def __init__(self):
        self._cache = {}
        self._ui_family = None
        self._mono_family = None

    def _family(self, names, fallback_generic):
        for name in names:
            try:
                return FontFamily(name)
            except Exception:
                continue
        return fallback_generic()

    def ui_family(self):
        if self._ui_family is None:
            self._ui_family = self._family(
                ["Segoe UI Variable Text", "Segoe UI", "Tahoma"],
                lambda: FontFamily.GenericSansSerif,
            )
        return self._ui_family

    def mono_family(self):
        if self._mono_family is None:
            self._mono_family = self._family(
                ["Consolas", "Courier New"], lambda: FontFamily.GenericMonospace
            )
        return self._mono_family

    def get(self, role, scale):
        key = (role, round(scale, 3))
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        if role == "eyebrow":
            font = Font(self.ui_family(), FS_EYEBROW * scale, FontStyle.Bold, GraphicsUnit.Pixel)
        elif role == "label":
            font = Font(self.ui_family(), FS_LABEL * scale, FontStyle.Regular, GraphicsUnit.Pixel)
        elif role == "title":
            font = Font(self.ui_family(), FS_TITLE * scale, FontStyle.Bold, GraphicsUnit.Pixel)
        elif role == "hero":
            font = Font(self.mono_family(), FS_HERO * scale, FontStyle.Bold, GraphicsUnit.Pixel)
        elif role == "mono":
            font = Font(self.mono_family(), FS_BODY * scale, FontStyle.Regular, GraphicsUnit.Pixel)
        else:
            font = Font(self.ui_family(), FS_BODY * scale, FontStyle.Regular, GraphicsUnit.Pixel)
        self._cache[key] = font
        return font


_fonts = _Fonts() if _gdi_ready else None


def _draw_text(gfx, text, font, rgb, x, y, fmt, alpha=255):
    """Draw a string over a dark shadow.

    Without this the overlay is only readable where its own panel is opaque. The
    whole point of a low opacity is to see the game through the panel -- and the
    game underneath is Trove's own bright HUD as often as it is terrain, so the
    text needs its own contrast rather than borrowing the panel's. One offset
    dark copy costs a second DrawString and buys legibility at every setting,
    including a fully transparent panel.
    """
    if not text:
        return
    shadow = Color.FromArgb(int(alpha * 0.72), 0, 0, 0)
    gfx.DrawString(text, font, SolidBrush(shadow), PointF(float(x) + 1.0, float(y) + 1.0), fmt)
    gfx.DrawString(text, font, SolidBrush(_color(rgb, alpha)), PointF(float(x), float(y)), fmt)


def _rounded_path(x, y, w, h, radius):
    path = GraphicsPath()
    d = radius * 2
    path.AddArc(float(x), float(y), float(d), float(d), 180.0, 90.0)
    path.AddArc(float(x + w - d), float(y), float(d), float(d), 270.0, 90.0)
    path.AddArc(float(x + w - d), float(y + h - d), float(d), float(d), 0.0, 90.0)
    path.AddArc(float(x), float(y + h - d), float(d), float(d), 90.0, 90.0)
    path.CloseFigure()
    return path


_STATE_COLORS = {
    "ok": SUCCESS,
    "live": SUCCESS,
    "warn": WARNING,
    "soon": WARNING,
    "muted": INK_MUTED,
    "next": INK_PLACEHOLDER,
}


def _measure(gfx, text, font):
    if not text:
        return 0.0, 0.0
    # StringFormat.GenericTypographic drops the padding MeasureString otherwise
    # adds, which at these sizes is several pixels of phantom width per line and
    # makes right-aligned countdowns visibly drift from the panel edge.
    size = gfx.MeasureString(text, font, PointF(0.0, 0.0), _typographic())
    return float(size.Width), float(size.Height)


_fmt_cache = {}


def _typographic():
    """Shared typographic StringFormat, measured and drawn with identically.

    Measuring with one StringFormat and drawing with another is how
    right-aligned text ends up a few pixels off the edge it was measured
    against, so both paths go through this.
    """
    fmt = _fmt_cache.get("typographic")
    if fmt is None:
        fmt = StringFormat(StringFormat.GenericTypographic)
        fmt.FormatFlags = StringFormatFlags(int(fmt.FormatFlags) | 0x00000800)  # MeasureTrailingSpaces
        _fmt_cache["typographic"] = fmt
    return fmt


def measure_widget(gfx, widget, scale):
    """Compute a widget's pixel size without drawing it."""
    lines = widget.get("lines") or []
    inner_w = 0.0
    total_h = 0.0
    first = True

    for line in lines:
        role = line.get("role", "body")
        font = _fonts.get(role, scale)
        left_w, left_h = _measure(gfx, line.get("text", ""), font)
        right = line.get("right")
        right_w = 0.0
        if right:
            right_font = _fonts.get("mono", scale)
            right_w, right_h = _measure(gfx, right, right_font)
            left_h = max(left_h, right_h)
            right_w += GAP * 3 * scale
        bar = GAP * 2 * scale if line.get("bar") else 0.0
        inner_w = max(inner_w, left_w + right_w + bar)
        if not first:
            total_h += GAP * scale * (1.5 if role == "eyebrow" else 1.0)
        total_h += left_h
        first = False

    width = inner_w + PAD_X * 2 * scale
    height = total_h + PAD_Y * 2 * scale
    width = max(WIDGET_MIN_W * scale, min(WIDGET_MAX_W * scale, width))
    return int(round(width)), int(round(height))


def draw_widget(gfx, widget, x, y, w, h, scale, opacity, accent):
    """Paint one widget panel at (x, y).

    ``opacity`` fades the PANEL only. Text, the border and the buff bar stay
    fully opaque: the point of turning the overlay down is to see more of the
    game through it, not to make the numbers harder to read. Fading everything
    together made 50% unusable and left no useful range on the slider.
    """
    fill_alpha = int(round(max(0.0, min(1.0, opacity)) * 255))

    path = _rounded_path(x, y, w, h, int(RADIUS * scale))
    if fill_alpha > 0:
        gfx.FillPath(SolidBrush(_color(PANEL, fill_alpha)), path)

    from System.Drawing import Pen
    if widget.get("highlight"):
        pen = Pen(_color(accent, 235), 1.0)
    else:
        # The hairline tracks the fill a little so a nearly-invisible panel
        # doesn't keep a hard bright outline around nothing.
        pen = Pen(Color.FromArgb(max(20, int(46 * (fill_alpha / 255.0))), 255, 255, 255), 1.0)
    gfx.DrawPath(pen, path)
    pen.Dispose()
    path.Dispose()

    # Text is drawn at full strength regardless of the panel's opacity.
    alpha = 255

    fmt = _typographic()
    cursor_y = y + PAD_Y * scale
    inner_x = x + PAD_X * scale
    inner_right = x + w - PAD_X * scale
    first = True

    for line in widget.get("lines") or []:
        role = line.get("role", "body")
        font = _fonts.get(role, scale)
        text = line.get("text", "")
        _, line_h = _measure(gfx, text or "M", font)

        if not first:
            cursor_y += GAP * scale * (1.5 if role == "eyebrow" else 1.0)

        text_x = inner_x
        bar_rgb = parse_hex(line.get("bar"))
        if bar_rgb:
            # A data-driven colour may never sit behind text (DESIGN.md), so the
            # buff's hue goes on a 2px bar beside it.
            from System.Drawing import RectangleF as _Rect
            gfx.FillRectangle(SolidBrush(_color(bar_rgb, alpha)),
                              _Rect(float(inner_x), float(cursor_y + 2),
                                    float(2 * scale), float(line_h - 4)))
            text_x = inner_x + GAP * 2 * scale

        rgb = parse_hex(line.get("color")) or _STATE_COLORS.get(line.get("state"), INK)
        if role in ("label", "eyebrow") and not line.get("color") and not line.get("state"):
            rgb = INK_MUTED
        _draw_text(gfx, text, font, rgb, text_x, cursor_y, fmt, alpha)

        right = line.get("right")
        if right:
            right_font = _fonts.get("mono", scale)
            right_w, _ = _measure(gfx, right, right_font)
            right_rgb = _STATE_COLORS.get(line.get("right_state"), INK_MUTED)
            _draw_text(gfx, right, right_font, right_rgb,
                       inner_right - right_w, cursor_y, fmt, alpha)

        cursor_y += line_h
        first = False


def place_widget(anchor, fx, fy, w, h, canvas_w, canvas_h):
    """Anchor corner + fractional offset -> absolute top-left pixel."""
    x = fx * canvas_w if anchor.endswith("left") else canvas_w - fx * canvas_w - w
    y = fy * canvas_h if anchor.startswith("top") else canvas_h - fy * canvas_h - h
    # Never let a widget leave the canvas, whatever the config says.
    x = max(0, min(canvas_w - w, x))
    y = max(0, min(canvas_h - h, y))
    return int(round(x)), int(round(y))


def render(width, height, widgets, *, scale=1.0, opacity=0.92, accent=(94, 198, 255)):
    """Draw the whole overlay. Returns ``(bitmap, hit_rects)``.

    ``hit_rects`` is ``[(widget_id, x, y, w, h)]`` in canvas pixels, used for
    drag hit-testing while the overlay is interactive.
    """
    if not _gdi_ready:
        return None, []

    bitmap = Bitmap(int(width), int(height), PixelFormat.Format32bppPArgb)
    gfx = Graphics.FromImage(bitmap)
    gfx.SmoothingMode = SmoothingMode.AntiAlias
    # AntiAliasGridFit, not ClearType: subpixel AA bakes the *background* into
    # the glyph edges, and there is no background here — the result is coloured
    # fringing wherever the overlay is transparent.
    gfx.TextRenderingHint = TextRenderingHint.AntiAliasGridFit
    gfx.Clear(Color.FromArgb(0, 0, 0, 0))

    hit_rects = []
    for widget in widgets:
        w_scale = scale * float(widget.get("scale", 1.0) or 1.0)
        w, h = measure_widget(gfx, widget, w_scale)
        pin = widget.get("_pin")
        if pin:
            # Live drag feedback: follow the cursor rather than the stored
            # anchor, which only updates once the drag is released.
            x = max(0, min(int(width) - w, int(pin[0])))
            y = max(0, min(int(height) - h, int(pin[1])))
        else:
            x, y = place_widget(widget.get("anchor", "top-left"),
                                float(widget.get("x", 0.0)), float(widget.get("y", 0.0)),
                                w, h, width, height)
        draw_widget(gfx, widget, x, y, w, h, w_scale, opacity, accent)
        hit_rects.append((widget.get("id"), x, y, w, h))

    gfx.Dispose()
    return bitmap, hit_rects
