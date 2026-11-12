/** Offline verified Notes rollback; stop the selected DSH profile before running this command. */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { WriteOwner } from './write-owner.js'
import { Notes } from './notes.js'
import { Store, dshHome } from './store.js'

if (!process.argv[2]) throw new Error('Usage: notes-rollback.js <migration-id>; set DSH_HOME and WIKI_PATH for the stopped profile')
const ownership = new WriteOwner(join(dshHome(), 'media-desk'), process.env.WIKI_PATH ?? join(homedir(), 'wiki'))
try {
  await ownership.acquire()
  const store = new Store(ownership.dataRoot, ownership)
  store.notes = new Notes(ownership)
  await store.notes.init()
  await store.refresh()
  const result = await store.migration.rollback(process.argv[2])
  process.stdout.write(JSON.stringify(result) + '\n')
} finally { await ownership.release() }
