import {mkdir, readFile, writeFile} from 'node:fs/promises'
const logic = (await readFile('src/logic.js', 'utf8')).replace(/^export /gm, '')
const entry = (await readFile('src/index.js', 'utf8')).replace(
  /^import \{createWalletSweep, SweepError\} from '\.\/logic\.js'\s*$/m,
  ''
)
await mkdir('dist', {recursive: true})
await writeFile('dist/index.bundle.js', `${logic}\n${entry}`)
