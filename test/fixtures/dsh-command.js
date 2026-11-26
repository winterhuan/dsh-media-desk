/** Resolve a JavaScript CLI entry so native Windows does not spawn a .cmd shim. */
import { access } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

/** @returns {Promise<string>} Installed DSH entry, overridable with DSH_CLI. */
export async function dshEntry() {
  if (process.env.DSH_CLI) {
    const entry = resolve(process.env.DSH_CLI)
    await access(entry)
    return entry
  }
  const require = createRequire(import.meta.url)
  try { return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js') }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  const directories = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)]
  for (const directory of directories) {
    for (const path of ['node_modules/@deepseek-ai/dsh/lib/bin.js', '../lib/node_modules/@deepseek-ai/dsh/lib/bin.js']) {
      const entry = resolve(directory, path)
      try { await access(entry); return entry }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
    }
  }
  throw new Error('Install DSH or set DSH_CLI to its lib/bin.js entry')
}
