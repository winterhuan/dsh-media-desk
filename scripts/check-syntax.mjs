// This JavaScript package checks syntax; it does not provide static type checking.
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      checkDirectory(path)
      continue
    }
    if (!/\.m?js$/.test(entry.name)) continue
    const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
for (const directory of ['src', 'scripts', 'test']) checkDirectory(resolve(root, directory))
