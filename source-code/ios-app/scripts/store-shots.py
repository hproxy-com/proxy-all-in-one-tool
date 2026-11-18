"""The App Store's screenshots from the Simulator's pictures (scripts/pictures.sh): Apple refuses
any picture with an alpha channel, so each is flattened onto the app's own background colour.

    python ios-app/scripts/store-shots.py <pictures folder> <out folder>
"""
import pathlib
import sys

from PIL import Image

BACKGROUND = (0x07, 0x0A, 0x12)
# The order the store shows them in: what the app does first.
ORDER = ["connected", "proxies", "stopped", "settings", "off"]

source = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
for device in ["iphone", "ipad"]:
    for n, name in enumerate(ORDER, start=1):
        picture = source / f"{device}-{name}.png"
        if not picture.exists():
            continue
        image = Image.open(picture).convert("RGBA")
        flat = Image.new("RGB", image.size, BACKGROUND)
        flat.paste(image, mask=image.getchannel("A"))
        target = out / f"{device}-{n}-{name}.png"
        flat.save(target, optimize=True)
        print(target.name, flat.size, flat.mode)
