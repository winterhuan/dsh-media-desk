// This JavaScript package checks syntax; it does not provide static type checking.
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
for (const directory of ['src', 'scripts', 'test']) {
  for (const file of readdirSync(resolve(root, directory))) {
    if (!/\.m?js$/.test(file)) continue
    const result = spawnSync(process.execPath, ['--check', resolve(root, directory, file)], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
