/* Builds the Windows app icon and the downscaled UI art from the source renders. */
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const assets = 'src/renderer/assets'
await mkdir('build', { recursive: true })

/* build/icon-source.png is the authored 1024px master; the old render is the fallback. */
const iconSrc = existsSync('build/icon-source.png') ? 'build/icon-source.png' : path.join(assets, 'icon-src.png')

const sizes = [16, 24, 32, 48, 64, 128, 256]
const buffers = []
for (const size of sizes) {
  buffers.push(await sharp(iconSrc).resize(size, size, { fit: 'cover' }).png().toBuffer())
}
await writeFile('build/icon.ico', await pngToIco(buffers))
await sharp(iconSrc).resize(512, 512).png({ compressionLevel: 9 }).toFile('build/icon.png')
await sharp(iconSrc).resize(256, 256).png({ compressionLevel: 9 }).toFile(path.join(assets, 'mark.png'))

for (const name of ['empty-library', 'empty-conflicts', 'empty-crashes']) {
  /* The full-size masters are not committed; skip when only the -320 renders are present. */
  if (!existsSync(path.join(assets, `${name}.png`))) continue
  await sharp(path.join(assets, `${name}.png`))
    .resize(320, 320)
    .png({ compressionLevel: 9, palette: true })
    .toFile(path.join(assets, `${name}-320.png`))
}
console.log(`icons written from ${iconSrc} (.ico frames: ${sizes.join(', ')})`)
