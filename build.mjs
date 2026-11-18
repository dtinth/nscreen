// Bundles the display shell into one self-contained dist/index.html.
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const out = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  write: false,
})
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
const html = (await readFile('src/index.html', 'utf8')).replace('/*__DISPLAY_JS__*/', () => js)
await mkdir('dist', { recursive: true })
await writeFile('dist/index.html', html)
console.log(`dist/index.html  ${(html.length / 1024).toFixed(1)} KB`)
