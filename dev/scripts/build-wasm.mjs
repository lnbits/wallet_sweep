import {execFileSync} from 'node:child_process'
import {copyFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const dev = fileURLToPath(new URL('../', import.meta.url))
const target = 'wasm32-wasip2'
const cargoHome = resolve(process.env.CARGO_HOME || resolve(homedir(), '.cargo'))
const flags = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f')
  ?? (process.env.RUSTFLAGS || '').split(/\s+/).filter(Boolean)
// Keep local Cargo registry paths out of the distributed binary's panic locations.
flags.push(`--remap-path-prefix=${cargoHome}=/cargo`)

execFileSync('cargo', ['build', '--locked', '--release', '--target', target, '--target-dir', 'target'], {
  cwd: dev,
  env: {...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f')},
  stdio: 'inherit'
})
copyFileSync(resolve(dev, 'target', target, 'release/wallet_sweep.wasm'), resolve(dev, '../wasm/module.wasm'))
