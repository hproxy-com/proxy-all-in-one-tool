"""Pictures of HProxy's screens, drawn pixel for pixel the way the Flipper Zero draws them.

There is no Flipper Zero emulator. So this draws each screen of the app with the firmware's own
rules: the fonts are the very u8g2 fonts the firmware carries (read from its u8g2_fonts.c), the
font decoder, the string width, the boxes, rounded frames and circles follow u8g2's code, and the
menus, the text box (its line breaks too), the scrollbar and the progress bar follow the
firmware's gui modules (submenu.c, text_box.c, elements.c of release 1.5.1). The progress screen
is the app's own progress_draw (hproxy.c), and the keyboard its keyboard_draw (keyboard.c), with
the layout read from hproxy_keys.c itself. What each screen says is what the app says: the
result and connector texts are the strings tests/test_hproxy_api.c checks. The addresses are
documentation addresses (RFC 5737), never real proxies.

    python tools/screens.py            # writes screenshots/*.png (4x, crisp) and screenshots/all.png

The firmware's font file (30 MB) is downloaded once into tools/.cache/ and is never committed:
its fonts carry their own licences. Only the pictures are.
"""

import re
import sys
import urllib.request
from pathlib import Path

from PIL import Image

FIRMWARE = "1.5.1"
FONTS_URL = f"https://raw.githubusercontent.com/flipperdevices/flipperzero-firmware/{FIRMWARE}/lib/u8g2/u8g2_fonts.c"
HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache" / f"u8g2_fonts-{FIRMWARE}.c"
OUT = HERE.parent / "screenshots"

SCALE = 4
LIT = (0, 0, 0)  # a pixel that is on
BACKLIGHT = (255, 130, 0)  # the Flipper's orange screen


# ---- the fonts: u8g2's format, read straight from the firmware's C arrays -----------------------


def c_string_bytes(literals: str) -> bytes:
    """The bytes of C string literals, escapes and all."""
    out = bytearray()
    for body in re.findall(r'"((?:[^"\\]|\\.)*)"', literals, re.S):
        i = 0
        while i < len(body):
            ch = body[i]
            if ch != "\\":
                out.append(ord(ch))
                i += 1
                continue
            nxt = body[i + 1]
            if nxt in "01234567":
                j = i + 1
                while j < len(body) and j < i + 4 and body[j] in "01234567":
                    j += 1
                out.append(int(body[i + 1 : j], 8))
                i = j
            elif nxt == "x":
                j = i + 2
                while j < len(body) and body[j] in "0123456789abcdefABCDEF":
                    j += 1
                out.append(int(body[i + 2 : j], 16) & 0xFF)
                i = j
            else:
                out.append({"n": 10, "t": 9, "r": 13, "a": 7, "b": 8, "f": 12, "v": 11}.get(nxt, ord(nxt)))
                i += 2
    return bytes(out)


LITERAL = re.compile(r'\s*("(?:[^"\\]|\\.)*")', re.S)


def font_bytes(source: str, name: str) -> bytes:
    m = re.search(rf"const uint8_t {name}\[(\d+)\][^=]*=", source)
    if not m:
        raise SystemExit(f"{name} is not in the firmware's u8g2_fonts.c")
    # The literals one after another, up to the semicolon outside them: a font's bytes hold ';'.
    pos, literals = m.end(), []
    while (lit := LITERAL.match(source, pos)) is not None:
        literals.append(lit.group(1))
        pos = lit.end()
    data = c_string_bytes("".join(literals))
    size = int(m.group(1))
    if len(data) < size - 1:
        raise SystemExit(f"{name}: read {len(data)} bytes, the array holds {size}")
    return data[:size]


def s8(b: int) -> int:
    return b - 256 if b > 127 else b


class Font:
    """u8g2_read_font_info and u8g2_font_get_glyph_data."""

    def __init__(self, name: str, data: bytes):
        self.name = name
        self.data = data
        (
            self.glyph_cnt,
            self.bbx_mode,
            self.bits_per_0,
            self.bits_per_1,
            self.bits_w,
            self.bits_h,
            self.bits_x,
            self.bits_y,
            self.bits_dx,
            self.max_w,
            self.max_h,
        ) = data[0:11]
        self.ascent_a = s8(data[13])
        self.upper_a = (data[17] << 8) | data[18]
        self.lower_a = (data[19] << 8) | data[20]

    def glyph(self, encoding: int):
        p = 23
        if encoding >= ord("a"):
            p += self.lower_a
        elif encoding >= ord("A"):
            p += self.upper_a
        while True:
            if self.data[p + 1] == 0:
                return None
            if self.data[p] == encoding:
                return p + 2
            p += self.data[p + 1]


class Bits:
    """u8g2_font_decode_get_unsigned_bits and _signed_bits: least significant bit first."""

    def __init__(self, data: bytes, pos: int):
        self.data, self.ptr, self.bit = data, pos, 0

    def byte(self, at: int) -> int:
        # C reads one byte past a glyph's last bits without using it; here that byte may not exist.
        return self.data[at] if at < len(self.data) else 0

    def u(self, cnt: int) -> int:
        val = self.byte(self.ptr) >> self.bit
        end = self.bit + cnt
        if end >= 8:
            shift = 8 - self.bit
            self.ptr += 1
            val |= self.byte(self.ptr) << shift
            end -= 8
        self.bit = end
        return val & ((1 << cnt) - 1)

    def s(self, cnt: int) -> int:
        return self.u(cnt) - (1 << (cnt - 1))


# ---- the canvas: 128 x 64, u8g2's primitives -----------------------------------------------------

WHITE, BLACK = 0, 1


class Canvas:
    def __init__(self):
        self.px = [[0] * 128 for _ in range(64)]
        self.color = BLACK
        self.font = None

    # u8g2_DrawPixel, DrawHLine, DrawVLine, DrawBox, DrawFrame
    def pixel(self, x, y):
        if 0 <= x < 128 and 0 <= y < 64:
            self.px[y][x] = self.color

    def hline(self, x, y, w):
        for i in range(int(w)):
            self.pixel(x + i, y)

    def vline(self, x, y, h):
        for i in range(int(h)):
            self.pixel(x, y + i)

    def box(self, x, y, w, h):
        for j in range(int(h)):
            self.hline(int(x), int(y) + j, w)

    # u8g2_draw_disc_section / u8g2_draw_disc, u8g2_draw_circle_section / u8g2_draw_circle
    def _quarter(self, x0, y0, rad, option, disc):
        f, ddf_x, ddf_y, x, y = 1 - rad, 1, -2 * rad, 0, rad

        def section(x, y):
            for opt, sx, sy in (("ur", 1, -1), ("ul", -1, -1), ("lr", 1, 1), ("ll", -1, 1)):
                if opt != option:
                    continue
                if disc:
                    top = sy < 0
                    self.vline(x0 + sx * x, y0 - y if top else y0, y + 1)
                    self.vline(x0 + sx * y, y0 - x if top else y0, x + 1)
                else:
                    self.pixel(x0 + sx * x, y0 + sy * y)
                    self.pixel(x0 + sx * y, y0 + sy * x)

        section(x, y)
        while x < y:
            if f >= 0:
                y -= 1
                ddf_y += 2
                f += ddf_y
            x += 1
            ddf_x += 2
            f += ddf_x
            section(x, y)

    # u8g2_DrawRBox
    def rbox(self, x, y, w, h, r):
        xl, yu = x + r, y + r
        xr, yl = x + w - r - 1, y + h - r - 1
        for cx, cy, opt in ((xl, yu, "ul"), (xr, yu, "ur"), (xl, yl, "ll"), (xr, yl, "lr")):
            self._quarter(cx, cy, r, opt, disc=True)
        ww = w - 2 * r
        xl += 1
        yu += 1
        if ww >= 3:
            ww -= 2
            self.box(xl, y, ww, r + 1)
            self.box(xl, yl, ww, r + 1)
        hh = h - 2 * r
        if hh >= 3:
            hh -= 2
            self.box(x, yu, w, hh)

    # u8g2_DrawRFrame
    def rframe(self, x, y, w, h, r):
        xl, yu = x + r, y + r
        xr, yl = x + w - r - 1, y + h - r - 1
        for cx, cy, opt in ((xl, yu, "ul"), (xr, yu, "ur"), (xl, yl, "ll"), (xr, yl, "lr")):
            self._quarter(cx, cy, r, opt, disc=False)
        ww, hh = w - 2 * r, h - 2 * r
        xl += 1
        yu += 1
        if ww >= 3:
            ww -= 2
            h -= 1
            self.hline(xl, y, ww)
            self.hline(xl, y + h, ww)
        if hh >= 3:
            hh -= 2
            w -= 1
            self.vline(x, yu, hh)
            self.vline(x + w, yu, hh)

    # u8g2_font_decode_glyph (font mode 1: only the glyph's own pixels are drawn)
    def glyph(self, x, y, encoding) -> int:
        f = self.font
        p = f.glyph(encoding)
        if p is None:
            return 0
        b = Bits(f.data, p)
        w, h = b.u(f.bits_w), b.u(f.bits_h)
        gx, gy, dx = b.s(f.bits_x), b.s(f.bits_y), b.s(f.bits_dx)
        if w > 0:
            tx, ty = x + gx, y - (h + gy)
            pos = [0, 0]

            def run(length, lit):
                cnt = length
                while True:
                    rem = w - pos[0]
                    cur = cnt if cnt < rem else rem
                    if lit:
                        self.hline(tx + pos[0], ty + pos[1], cur)
                    if cnt < rem:
                        break
                    cnt -= rem
                    pos[0] = 0
                    pos[1] += 1
                pos[0] += cnt

            while True:
                a, n = b.u(f.bits_per_0), b.u(f.bits_per_1)
                while True:
                    run(a, False)
                    run(n, True)
                    if b.u(1) == 0:
                        break
                if pos[1] >= h:
                    break
        return dx

    # canvas_draw_str: u8g2_DrawUTF8, the baseline at y
    def text(self, x, y, s):
        for ch in s:
            x += self.glyph(x, y, ord(ch))

    # u8g2_string_width: the advances, the last glyph by its own width and offset
    def width(self, s) -> int:
        f = self.font
        w = dx = last_w = last_x = 0
        for ch in s:
            p = f.glyph(ord(ch))
            if p is None:
                dx, last_w = 0, 0
                continue
            b = Bits(f.data, p)
            last_w = b.u(f.bits_w)
            b.u(f.bits_h)
            last_x = b.s(f.bits_x)
            b.s(f.bits_y)
            dx = b.s(f.bits_dx)
            w += dx
        if last_w != 0:
            w = w - dx + last_w + last_x
        return w

    # u8g2_GetGlyphWidth, canvas_glyph_width: a glyph's advance
    def advance(self, ch) -> int:
        f = self.font
        p = f.glyph(ord(ch))
        if p is None:
            return 0
        b = Bits(f.data, p)
        b.u(f.bits_w)
        b.u(f.bits_h)
        b.s(f.bits_x)
        b.s(f.bits_y)
        return b.s(f.bits_dx)

    # canvas_draw_str_aligned
    def text_aligned(self, x, y, horizontal, vertical, s):
        if horizontal == "right":
            x -= self.width(s)
        elif horizontal == "center":
            x -= self.width(s) // 2
        if vertical == "top":
            y += self.font.ascent_a
        elif vertical == "center":
            y += self.font.ascent_a // 2
        self.text(x, y, s)

    # canvas_current_font_height
    def font_height(self) -> int:
        return self.font.max_h + (1 if self.font.name == "haxrcorp4089" else 0)


# ---- the firmware's elements (elements.c) --------------------------------------------------------


def scrollbar(c: Canvas, pos: int, total: int):
    c.color = WHITE
    c.box(125, 0, 3, 64)
    c.color = BLACK
    for i in range(0, 64, 2):
        c.pixel(126, i)
    if total:
        block = 64 / total
        c.box(125, int(block * pos), 3, int(max(block, 1)))


def progress_bar(c: Canvas, x, y, width, progress):
    height = 9
    filled = int(progress * (width - 2) + 0.5)  # roundf: halves away from zero
    c.color = WHITE
    c.box(x + 1, y + 1, width - 2, height - 2)
    c.color = BLACK
    c.rframe(x, y, width, height, 3)
    c.box(x + 1, y + 1, filled, height - 2)


def fit_width(c: Canvas, s: str, width: int) -> str:
    if c.width(s) > width:
        width -= c.width("...")
        while True:
            s = s[:-1]
            if c.width(s) <= width:
                break
        s += "..."
    return s


# ---- the views: the firmware's modules, and the app's own screens --------------------------------


def multiline(c: Canvas, x, y, text):
    """elements_multiline_text: one line under the other, a font height apart."""
    for i, line in enumerate(text.split("\n")):
        c.text(x, y + i * c.font_height(), line)


def submenu(fonts, header, items, position=0, window=0) -> Canvas:
    c = Canvas()
    if header:
        c.font = fonts["primary"]
        c.text(4, 11, header)
    c.font = fonts["secondary"]
    on_screen, y_offset = (3, 16) if header else (4, 0)
    for pos, label in enumerate(items):
        item = pos - window
        if 0 <= item < on_screen:
            if pos == position:
                c.color = BLACK
                c.rbox(0, y_offset + item * 16 + 1, 123, 14, 1)
                c.color = WHITE
            else:
                c.color = BLACK
            c.text(6, y_offset + item * 16 + 12, fit_width(c, label, 123 - 12))
    scrollbar(c, position, len(items))
    return c


TEXT_BOX_TEXT_WIDTH = 120
TEXT_BOX_TEXT_HEIGHT = 56


def text_box(fonts, text, scroll=0) -> Canvas:
    """text_box.c: lines break where the next glyph would pass 120 pixels, then five at a time."""
    c = Canvas()
    c.font = fonts["secondary"]

    def next_line(offset):  # text_box_seek_next_line
        width = 0
        while offset < len(text):
            ch = text[offset]
            if ch == "\n":
                return offset + 1
            advance = c.advance(ch)
            if width + advance > TEXT_BOX_TEXT_WIDTH:
                return offset
            width += advance
            offset += 1
        return offset

    on_screen = TEXT_BOX_TEXT_HEIGHT // c.font_height()
    lines, offset = 0, 0  # text_box_prepare_model
    while True:
        offset = next_line(offset)
        lines += 1
        if offset >= len(text):
            break
    lines += 1
    scroll_num = lines - on_screen if lines > on_screen else 0

    offset = 0
    for _ in range(scroll):
        offset = next_line(offset)
    shown = []
    for _ in range(on_screen):  # text_box_update_screen_text
        start = offset
        offset = next_line(offset)
        line = text[start:offset]
        shown.append(line if line.endswith("\n") else line + "\n")
        if offset >= len(text):
            break
    c.color = BLACK
    c.rframe(0, 0, 124, 64, 1)
    scrollbar(c, scroll, scroll_num)
    multiline(c, 3, 11, "".join(shown).rstrip("\n"))
    return c


def progress(fonts, title, status, fraction, counts=None) -> Canvas:
    """hproxy.c, progress_draw."""
    c = Canvas()
    c.font = fonts["primary"]
    c.text_aligned(64, 2, "center", "top", title)
    c.font = fonts["secondary"]
    c.text_aligned(64, 16, "center", "top", status)
    if fraction >= 0:
        progress_bar(c, 6, 28, 116, fraction)
    if counts:
        works, dead, slow = counts
        c.text_aligned(64, 43, "center", "top", f"Work {works}   Dead {dead}   Slow {slow}")
    c.text_aligned(64, 63, "center", "bottom", "Back to stop")
    return c


# ---- the keyboard: keyboard.c, with the layout read from hproxy_keys.c -----------------------------

KEYS_SOURCE = HERE.parent / "hproxy_keys.c"
KEY = re.compile(
    r"C\('((?:\\.|[^'\\]))', (\d+)\)"  # C('q', 0)
    r"|\{HproxyKey(\w+), ('(?:\\.|[^'\\])'|0), (\d+), (\d+)\}"  # {HproxyKeyDelete, 0, 11, 2}
)


def key_pages():
    """The two pages, row by row: (kind, character, first slot, slots), as hproxy_keys.c has them."""
    source = KEYS_SOURCE.read_text(encoding="utf-8")
    arrays = {}
    for name, body in re.findall(r"static const HproxyKey (\w+)\[\] = \{(.*?)\n\};", source, re.S):
        keys = []
        for m in KEY.finditer(body):
            if m.group(1) is not None:
                ch = m.group(1)
                keys.append(("Char", ch[1] if ch.startswith("\\") else ch, int(m.group(2)), 1))
            else:
                kind = m.group(3)
                keys.append((kind, " " if kind == "Space" else "", int(m.group(5)), int(m.group(6))))
        arrays[name] = keys
    table = re.search(r"PAGES\[2\]\[HPROXY_KEY_ROWS\] = \{(.*?)\n\};", source, re.S).group(1)
    return [[arrays[name] for name in re.findall(r"ROW\((\w+)\)", page)] for page in re.findall(r"\{(ROW.*?)\}", table)]


def field_text(c: Canvas, text):
    """keyboard.c, draw_text: the end of the text that fits, "..." in front, the cursor after it."""
    left = 3
    room = 128 - left - 6
    start, width = len(text), 0
    while start > 0:
        w = c.advance(text[start - 1])
        if width + w > room:
            break
        width += w
        start -= 1
    x = left
    if start > 0:
        dots = c.width("...") + 2
        while start < len(text) and width > room - dots:
            width -= c.advance(text[start])
            start += 1
        c.text(left, 18, "...")
        x += dots
    c.text(x, 18, text[start:])
    c.box(x + width + 1, 11, 1, 9)


def keyboard(fonts, header, text, page=0, row=0, index=0, caps=False, message="") -> Canvas:
    """keyboard.c, keyboard_draw."""
    c = Canvas()
    c.font = fonts["secondary"]
    c.text(2, 7, header)
    c.rframe(0, 9, 128, 13, 1)
    if message:
        c.box(1, 10, 126, 11)
        c.color = WHITE
        c.text(3, 18, message)
        c.color = BLACK
    else:
        field_text(c, text)
    c.font = fonts["keyboard"]
    for r, keys in enumerate(key_pages()[page]):
        top = 23 + r * 10
        for i, (kind, ch, slot, slots) in enumerate(keys):
            x = 5 + slot * 9
            w = slots * 9 - 1
            c.color = BLACK
            if r == row and i == index:
                c.box(x, top, w, 10)
                c.color = WHITE
            if kind == "Char":
                shown = ch.upper() if caps and "a" <= ch <= "z" else ch
                c.glyph(x + 2, top + (5 if shown == "_" else 7), ord(shown))  # '_' two up, as keyboard.c
            elif kind == "Space":
                c.box(x + 4, top + 7, w - 8, 1)
                c.box(x + 4, top + 5, 1, 2)
                c.box(x + w - 5, top + 5, 1, 2)
            elif kind == "Shift":
                cx = x + 4
                c.box(cx, top + 2, 1, 1)
                c.box(cx - 1, top + 3, 3, 1)
                c.box(cx - 2, top + 4, 5, 1)
                c.box(cx - 1, top + 5, 3, 2)
                if caps:
                    c.box(cx - 2, top + 8, 5, 1)
            elif kind == "Delete":
                cx, cy = x + w // 2, top + 5
                c.box(cx - 4, cy, 1, 1)
                c.box(cx - 3, cy - 1, 1, 3)
                c.box(cx - 2, cy - 2, 1, 5)
                c.box(cx - 1, cy - 1, 6, 3)
            else:  # Page, Done: a word in the small font
                c.font = fonts["secondary"]
                word = "OK" if kind == "Done" else ("#+" if page == 0 else "abc")
                c.text_aligned(x + w // 2 + 1, top + 8, "center", "bottom", word)
                c.font = fonts["keyboard"]
    c.color = BLACK
    return c


# ---- the screens, as the app shows them ----------------------------------------------------------
#
# The words are the app's own: the result and connector texts are the strings tests/test_hproxy_api.c
# checks hproxy_api.c produces.

MY_LIST = [
    "Check all 12",
    "Add one",
    "Add from a link",
    "Add from a file",
    "Send logins: off",
    "socks5 203.0.113.24:1080",
    "alice@gate.example.com:7000",
    "198.51.100.7:8080",
]


def screens(fonts):
    """(file, caption, picture, on the sheet)."""
    return [
        ("menu", "The menu", submenu(fonts, "HProxy", ["My proxies", "Last results", "My connector", "Setup and help"]), True),
        ("my-proxies", "Your list: check it, add to it", submenu(fonts, "My proxies", MY_LIST), True),
        (
            "keyboard",
            "A keyboard with every character",
            keyboard(fonts, "A proxy, in any shape", "gate.example.com:7000:alice:s3c", row=3, index=3),
            True,
        ),
        (
            "results",
            "The protocol that answered, fastest first",
            submenu(
                fonts,
                "9 of 12 work",
                ["socks5 203.0.113.24:1080", "https 198.51.100.7:8080", "https+socks5 203.0.113.91:3128", "slow 198.51.100.44:1080"],
            ),
            True,
        ),
        (
            "detail",
            "One proxy, in detail, never its password",
            text_box(fonts, "gate.example.com:7000\nLogin: alice\n\nWorks, answered in 182 ms\nProtocols: http, https\nCountry: US\nAnonymity: elite\n"),
            True,
        ),
        (
            "new-ip",
            "New IP, from the Flipper",
            text_box(
                fonts,
                "Switched.\n\nProxy 4 of 10, http\ngw.example.com:7777\nLogin: alice\n\nConnections: 1234, 3 open\n"
                "Traffic: 12.3 MB up, 456.0 MB down\nRunning for 3 h 12 min\nhproxy 0.4.9\n",
            ),
            True,
        ),
        ("my-list", "The proxies on your list", submenu(fonts, "My proxies", MY_LIST, position=5, window=4), False),
        (
            "symbols",
            "The keyboard's second page",
            keyboard(fonts, "Its login, name:password", "alice:p@ss", page=1, row=1, index=2),
            False,
        ),
        ("checking", "Checking, live", progress(fonts, "Checking proxies", "20 of 30 checked", 20 / 30, (12, 5, 3)), False),
        (
            "connector",
            "Your connector",
            submenu(fonts, "My connector", ["New IP", "What it uses now", "Use proxy number...", "Address: 192.168.1.20:8080", "Login: none"]),
            False,
        ),
    ]


def picture(c: Canvas) -> Image.Image:
    img = Image.new("RGB", (128, 64), BACKLIGHT)
    pix = img.load()
    for y in range(64):
        for x in range(128):
            if c.px[y][x]:
                pix[x, y] = LIT
    return img.resize((128 * SCALE, 64 * SCALE), Image.NEAREST)


def main():
    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading the firmware's fonts ({FIRMWARE}) once: {FONTS_URL}")
        urllib.request.urlretrieve(FONTS_URL, CACHE)
    source = CACHE.read_text(encoding="utf-8", errors="replace")
    fonts = {
        "primary": Font("helvB08", font_bytes(source, "u8g2_font_helvB08_tr")),
        "secondary": Font("haxrcorp4089", font_bytes(source, "u8g2_font_haxrcorp4089_tr")),
        "keyboard": Font("profont11", font_bytes(source, "u8g2_font_profont11_mr")),
    }
    OUT.mkdir(exist_ok=True)
    sheet_pictures = []
    for name, caption, canvas, on_sheet in screens(fonts):
        img = picture(canvas)
        img.save(OUT / f"{name}.png", optimize=True)
        if on_sheet:
            sheet_pictures.append(img)
        print(f"screenshots/{name}.png  {caption}")
    gap = 16
    cols, rows = 3, 2
    w, h = sheet_pictures[0].size
    sheet = Image.new("RGB", (cols * w + (cols - 1) * gap, rows * h + (rows - 1) * gap), (255, 255, 255))
    for i, img in enumerate(sheet_pictures):
        sheet.paste(img, ((i % cols) * (w + gap), (i // cols) * (h + gap)))
    sheet.save(OUT / "all.png", optimize=True)
    print(f"screenshots/all.png  the first {len(sheet_pictures)}, on one sheet")


if __name__ == "__main__":
    sys.exit(main())
