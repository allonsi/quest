"""Draw the app's simple book emblem as PWA PNGs without image dependencies."""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]


def render(size):
    scale = size * 2 / 512
    width = size * 2
    pixels = bytearray(width * width * 4)

    def span(y, left, right, color):
        if 0 <= y < width:
            left, right = max(0, int(left)), min(width, int(right))
            if right > left:
                pixels[(y * width + left) * 4:(y * width + right) * 4] = bytes(color) * (right - left)

    def rounded_box(x, y, w, h, radius, color):
        x, y, w, h, radius = [v * scale for v in (x, y, w, h, radius)]
        for row in range(int(y), int(y + h)):
            distance = max(y + radius - row, row - (y + h - radius), 0)
            inset = radius - math.sqrt(max(0, radius * radius - distance * distance))
            span(row, x + inset, x + w - inset, color)

    def polygon(points, color):
        points = [(x * scale, y * scale) for x, y in points]
        for row in range(max(0, int(min(y for _, y in points))), min(width, int(max(y for _, y in points)) + 1)):
            intersections = []
            for index, (x1, y1) in enumerate(points):
                x2, y2 = points[(index + 1) % len(points)]
                if (y1 <= row < y2) or (y2 <= row < y1):
                    intersections.append(x1 + (row - y1) * (x2 - x1) / (y2 - y1))
            intersections.sort()
            for left, right in zip(intersections[::2], intersections[1::2]):
                span(row, left, right, color)

    pine, gold, paper, green = (38, 63, 53, 255), (197, 165, 109, 255), (242, 232, 205, 255), (110, 127, 99, 255)
    rounded_box(0, 0, 512, 512, 100, pine)
    rounded_box(37, 37, 438, 438, 79, gold)
    rounded_box(40, 40, 432, 432, 76, pine)
    left = [(94, 139), (130, 132), (165, 132), (200, 138), (230, 148), (256, 164), (256, 389), (230, 373), (200, 363), (165, 357), (130, 357), (94, 364)]
    right = [(512 - x, y) for x, y in left]
    polygon(left, gold)
    polygon(right, gold)
    polygon([(x + (7 if x < 250 else -2), y + (7 if y < 200 else -7)) for x, y in left], paper)
    polygon([(512 - x, y) for x, y in [(x + (7 if x < 250 else -2), y + (7 if y < 200 else -7)) for x, y in left]], paper)
    rounded_box(251, 158, 10, 224, 3, gold)
    for x in (133, 305):
        for y in (205, 246, 287):
            rounded_box(x, y, 74, 8, 4, green)
    polygon([(256, 57), (266, 83), (293, 93), (266, 103), (256, 130), (246, 103), (219, 93), (246, 83)], gold)
    # 2x supersampling keeps diagonals smooth at both install icon sizes.
    output = bytearray()
    for y in range(size):
        output.append(0)
        for x in range(size):
            for channel in range(4):
                output.append(sum(pixels[((y * 2 + dy) * width + x * 2 + dx) * 4 + channel] for dy in range(2) for dx in range(2)) // 4)

    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(output), 9)) + chunk(b'IEND', b'')
    (ROOT / 'web' / 'assets' / f'icon-{size}.png').write_bytes(png)


if __name__ == '__main__':
    for icon_size in (192, 512):
        render(icon_size)
    print('Created PWA icons: 192px, 512px')
