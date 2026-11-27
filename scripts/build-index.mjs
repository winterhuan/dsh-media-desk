/** Generate the fork market entry from an existing release tag containing its prebuilt client. */
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { reconcileDistTags } from './index-entry.mjs'

const root = new URL('..', import.meta.url)
const indexPath = new URL('index.json', root)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const index = JSON.parse(readFileSync(indexPath, 'utf8'))
const plugin = index.plugins.find(entry => entry.name === manifest.name)
if (!plugin) throw new Error(`No market entry for ${manifest.name}`)
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const commit = git('rev-parse', `refs/tags/v${manifest.version}^{commit}`)
const released = JSON.parse(git('show', `${commit}:package.json`))
if (released.name !== manifest.name || released.version !== manifest.version) throw new Error('Release tag does not match the package')
git('cat-file', '-e', `${commit}:dist/client.js`)
plugin.versions = [{ version: released.version, publishTimestamp: Number(git('show', '-s', '--format=%ct', commit)),
  source: { type: 'git', url: 'https://github.com/winterhuan/dsh-media-desk', commit }, engines: released.engines }]
reconcileDistTags(plugin, plugin.versions)
parseMarketIndex(index, 'https://raw.githubusercontent.com/winterhuan/dsh-media-desk/main/index.json')
const temporary = new URL('index.json.tmp', root)
writeFileSync(temporary, JSON.stringify(index, null, 2) + '\n')
renameSync(temporary, indexPath)
console.log(`${manifest.name}@${released.version}: ${commit}`)
