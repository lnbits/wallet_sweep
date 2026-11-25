import {readFileSync} from 'node:fs'
import {instantiate} from '../target/test-component/guest.js'

const modules = new Map()
function coreModule(name) {
  if (!modules.has(name)) {
    const bytes = readFileSync(new URL('../target/test-component/' + name, import.meta.url))
    modules.set(name, new WebAssembly.Module(bytes))
  }
  return modules.get(name)
}

export function component(interfaces) {
  // None of these tests grants WASI I/O. Resource classes are required at link time.
  const wasi = new Proxy({}, {
    get(_, name) { return function UnusedWasiImport() { throw new Error('Unexpected WASI call ' + String(name)) } }
  })
  return instantiate(coreModule, new Proxy(interfaces, {
    get(imports, name) { return String(name).startsWith('wasi:') ? wasi : imports[name] }
  }))
}
