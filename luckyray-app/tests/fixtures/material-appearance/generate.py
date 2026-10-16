"""Small generated non-sensitive fixtures. Requires Pillow; outputs no user files."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
root = Path(__file__).resolve().parent
first = Image.new('RGB', (80, 48), (35, 120, 200))
ImageDraw.Draw(first).rectangle((0, 0, 34, 29), fill=(235, 60, 45))
exif = Image.Exif(); exif[274] = 6
first.save(root / 'oriented.jpg', quality=93, exif=exif)
first.save(root / 'unoriented.jpg', quality=93)
with Image.open(root / 'oriented.jpg') as source:
    ImageOps.exif_transpose(source).save(root / 'oriented-expected.png')
frames = [Image.new('RGB', (8, 8), color) for color in [(220, 10, 20), (10, 220, 20)]]
frames[0].save(root / 'animated.png', save_all=True, append_images=frames[1:], duration=100, loop=0)
frames[0].save(root / 'animated.webp', save_all=True, append_images=frames[1:], duration=100, loop=0, lossless=True)
print('Generated five non-sensitive appearance fixtures.')
