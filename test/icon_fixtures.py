"""Test sites for the "Manifest & icons" section, full of deliberate mistakes.

Run:  python3 test/icon_fixtures.py
Then switch QuickTag on for localhost and open:
  http://localhost:8701/             linked manifest and icon links, with wrong sizes, types and a 404
  http://localhost:8701/broken.html  two manifest links, invalid JSON, an "icon" that is a web page
  http://localhost:8702/             nothing linked except an apple-touch-icon; /manifest.json and
                                     /favicon.ico exist, /site.webmanifest returns a web page
  http://localhost:8703/             no manifest and no favicon anywhere

Each request is logged, so you can see that /site.webmanifest, /manifest.json,
/manifest.webmanifest and /favicon.ico are only requested while the section is open.
The files are generated into a temporary folder; nothing is written to this repository.
"""

import json
import struct
import sys
import tempfile
import threading
import zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORTS = {'linked': 8701, 'unlinked': 8702, 'none': 8703}


def png(width, height, rgb):
    """A two-tone RGB PNG: a coloured square on a light background, so thumbnails look like icons."""
    inset = min(width, height) // 6
    rows = []
    for y in range(height):
        row = bytearray(b'\x00')  # filter type: none
        for x in range(width):
            inside = inset <= x < width - inset and inset <= y < height - inset
            row += bytes(rgb) if inside else b'\xf2\xf3\xf5'
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
        + chunk(b'IEND', b'')
    )


def dib(size, rgb):
    """A classic 32-bit BMP image for inside a .ico (height is doubled for the AND mask)."""
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    pixels = bytes([rgb[2], rgb[1], rgb[0], 255]) * size * size
    mask = b'\x00' * (((size + 31) // 32) * 4) * size
    return header + pixels + mask


def ico(images):
    """images: list of (width, height, data); data is a DIB or a PNG."""
    directory, blobs = b'', b''
    offset = 6 + 16 * len(images)
    for width, height, data in images:
        directory += struct.pack('<BBBBHHII', width % 256, height % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return struct.pack('<HHH', 0, 1, len(images)) + directory + blobs


def svg(rgb):
    color = '#%02x%02x%02x' % tuple(rgb)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="{color}"/></svg>'


def page(title, head):
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  {head}
</head>
<body><h1>{title}</h1><p>Open QuickTag's "Manifest &amp; icons" section.</p></body>
</html>
"""


BLUE, GREEN, ORANGE, PURPLE, RED = (79, 70, 229), (22, 163, 74), (234, 88, 12), (147, 51, 234), (220, 38, 38)
WEB_PAGE = page('Not found', '')  # what single-page apps send back for any unknown path

SITES = {
    'linked': {
        'index.html': page('Linked manifest and icons', """
  <link rel="manifest" href="/assets/site.webmanifest">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="icon" type="image/png" sizes="16x16 32x32 64x64" href="/favicon.ico">
  <link rel="icon" type="image/svg+xml" sizes="any" href="/icon.svg">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">"""),
        'broken.html': page('Broken manifest', """
  <link rel="manifest" href="/assets/broken.webmanifest">
  <link rel="manifest" href="/assets/site.webmanifest">
  <link rel="icon" href="/not-an-image.png">"""),
        'favicon-32x32.png': png(32, 32, BLUE),  # correct
        'favicon-16x16.png': png(32, 32, BLUE),  # declared 16x16, really 32x32
        'favicon.ico': ico([(16, 16, dib(16, BLUE)), (32, 32, dib(32, BLUE)), (48, 48, png(48, 48, BLUE))]),  # no 64x64; not a PNG
        'icon.svg': svg(BLUE),
        'apple-touch-icon.png': png(180, 180, BLUE),
        'not-an-image.png': WEB_PAGE,
        'assets/site.webmanifest': json.dumps({
            'name': 'Fixture Store',
            'short_name': 'Fixture',
            'start_url': '/',
            'display': 'standalone',
            'theme_color': '#1c1d21',
            'background_color': '#ffffff',
            'icons': [
                # Relative paths resolve against the manifest (/assets/), not the page.
                {'src': 'icons/android-chrome-192x192.png', 'sizes': '192x192', 'type': 'image/png'},
                {'src': 'icons/android-chrome-512x512.png', 'sizes': '512x512', 'type': 'image/png'},
                {'src': '/missing-icon.png', 'sizes': '256x256', 'type': 'image/png'},
                {'src': 'icons/maskable.png', 'sizes': '192x192', 'type': 'image/webp', 'purpose': 'any maskable'},
                {'src': 'icons/wide.png', 'sizes': '192x192', 'type': 'image/png'},
                {'src': 'icons/no-sizes.png', 'type': 'image/png'},
                {'src': 'icons/logo.svg', 'sizes': 'any', 'type': 'image/svg+xml'},
            ],
        }, indent=2),
        'assets/broken.webmanifest': '{\n  "name": "Broken",\n  "icons": [],\n}\n',  # trailing comma
        'assets/icons/android-chrome-192x192.png': png(192, 192, GREEN),
        'assets/icons/android-chrome-512x512.png': png(500, 500, GREEN),  # declared 512x512
        'assets/icons/maskable.png': png(192, 192, PURPLE),  # declared image/webp
        'assets/icons/wide.png': png(192, 180, ORANGE),  # declared 192x192, not square
        'assets/icons/no-sizes.png': png(144, 144, GREEN),
        'assets/icons/logo.svg': svg(GREEN),
    },
    'unlinked': {
        'index.html': page('Nothing linked', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">'),
        'apple-touch-icon.png': png(180, 180, RED),
        'site.webmanifest': WEB_PAGE,  # a 200 web page must not count as a manifest
        'manifest.json': json.dumps({
            'short_name': 'Unlinked',
            'icons': [{'src': '/icons/icon-192.png', 'sizes': '192x192', 'type': 'image/png'}],  # no 512x512
        }, indent=2),
        'icons/icon-192.png': png(192, 192, RED),
        'favicon.ico': ico([(16, 16, dib(16, RED)), (32, 32, dib(32, RED))]),
    },
    'none': {
        'index.html': page('No manifest, no favicon', ''),
    },
}


def build(root):
    for site, files in SITES.items():
        for name, content in files.items():
            path = root / site / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content.encode() if isinstance(content, str) else content)


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.webmanifest': 'application/manifest+json'}

    def log_message(self, fmt, *args):
        sys.stderr.write(f'[{self.server.server_port}] {fmt % args}\n')


def main():
    root = Path(tempfile.mkdtemp(prefix='quicktag-icons-'))
    build(root)
    servers = [ThreadingHTTPServer(('localhost', port), partial(Handler, directory=str(root / site))) for site, port in PORTS.items()]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f'Fixtures in {root}')
    for site, port in PORTS.items():
        print(f'  {site:9} http://localhost:{port}/')
    print('Press Ctrl+C to stop.', flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
