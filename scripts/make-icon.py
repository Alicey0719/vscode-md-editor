#!/usr/bin/env python3
# Generate a placeholder 128x128 icon at media/icon.png.
# Simple "M" glyph on a colored rounded-square background.

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def load_font(size: int) -> ImageFont.FreeTypeFont:
    # Try a few common paths for a sensible sans font. Fall back to PIL default.
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def make_icon(out: Path, size: int = 128) -> None:
    bg = (30, 132, 214)  # VSCode-ish blue
    fg = (255, 255, 255)
    radius = size // 5

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(((0, 0), (size, size)), radius=radius, fill=bg)

    font = load_font(size * 3 // 4)
    text = "M"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=fg)

    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    make_icon(Path(__file__).resolve().parent.parent / "media" / "icon.png")
