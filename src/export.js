// 一键保存：把成稿写成一个普通文件夹，脚本、封面、配图和分镜都在里面。
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { currentLang, tr } from './i18n.js'

export function defaultExportDir() {
  // 已经有中文文件夹的老用户切到英文后继续用原来的文件夹
  const zh = join(homedir(), 'Documents', '自媒体工作台')
  if (currentLang() !== 'en' || existsSync(zh)) return zh
  return join(homedir(), 'Documents', 'Media Desk')
}

export function resolveExportDir(value) {
  const dir = String(value ?? '').trim()
  if (!dir) return defaultExportDir()
  return dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir
}

function folderName(title) {
  const clean = String(title ?? '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60)
  return clean || tr('未命名')
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '｜').replace(/\n/g, ' ')
}

/**
 * @param {object} production - 成稿。
 * @param {{filesDir: string, exportDir: string, videoCover?: Buffer}} options - 素材目录、保存位置和合成好的视频封面。
 * @returns {Promise<{path: string, files: string[]}>} 文件夹路径和写入的文件名。
 */
export async function saveProduction(production, { filesDir, exportDir, videoCover, resolveMedia, snapshot = {} }) {
  // 英文界面用纯 ASCII 文件名，方便在别的系统和工具里打开
  const en = currentLang() === 'en'
  const names = en
    ? { cover: 'cover-original', videoCover: 'video-cover.jpg', figure: i => `figure-${i}`, shot: n => `shot-${n}`, script: 'script.md', board: 'storyboard.md' }
    : { cover: '封面原图', videoCover: '视频封面.jpg', figure: i => `配图${i}`, shot: n => `分镜${n}`, script: '脚本.md', board: '分镜脚本.md' }
  await mkdir(exportDir, { recursive: true })
  const target = await mkdtemp(join(exportDir, folderName(production.title) + '-'))
  const files = []
  const manifest = { version: 1, createdAt: new Date().toISOString(), ...snapshot, title: production.title, coverText: production.coverText, sources: production.sources ?? [], media: [], missing: [] }
  const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex')

  const copy = async (asset, name) => {
    if (!asset?.src) { manifest.missing.push({ name, status: asset?.status ?? 'absent', error: asset?.error }); return null }
    const legacy = /^media-desk\/files\/([\w.-]+)$/.exec(asset.src)
    const registered = /^media-desk\/media\/([a-f0-9-]{36})$/.exec(asset.src)
    let source
    let bytes
    try {
      if (registered && resolveMedia) source = await resolveMedia(registered[1])
      else if (legacy) source = join(filesDir, legacy[1])
      else { manifest.missing.push({ name, status: 'unregistered' }); return null }
      bytes = await readFile(source)
    } catch (error) { manifest.missing.push({ name, status: 'unavailable', error: error.message }); return null }
    const sha256 = fingerprint(bytes)
    if (asset.media && asset.media.sha256 !== sha256) { manifest.missing.push({ name, status: 'changed' }); return null }
    const file = name + extname(source)
    await writeFile(join(target, file), bytes, { flag: 'wx' })
    files.push(file)
    manifest.media.push({ file, sha256, reference: asset.media ?? { src: asset.src } })
    return file
  }

  const cover = await copy(production.cover, names.cover)
  if (videoCover) {
    if (production.cover?.src && !cover) throw new Error('The original cover is unavailable; regenerate the composed cover before export')
    await writeFile(join(target, names.videoCover), videoCover)
    files.push(names.videoCover)
    manifest.videoCover = { file: names.videoCover, sha256: fingerprint(videoCover), source: production.cover?.media ?? null, text: production.coverText || production.title }
  }
  const figures = []
  for (const [i, image] of (production.images ?? []).entries()) {
    figures.push({ image, file: await copy(image, names.figure(i + 1)) })
  }
  const shots = []
  for (const [i, shot] of (production.shots ?? []).entries()) {
    shots.push({ shot, file: await copy(shot, names.shot(String(i + 1).padStart(2, '0'))) })
  }

  // 配图放回对应小标题那一节的末尾
  const sections = String(production.article ?? '').split(/\n(?=##\s)/)
  const unplaced = []
  for (const { image, file } of figures) {
    if (!file) continue
    const line = `\n\n![${image.caption ?? ''}](${file})`
    const at = sections.findIndex(part => image.anchor && part.startsWith(`## ${image.anchor}`))
    if (at >= 0) sections[at] = `${sections[at].trimEnd()}${line}\n`
    else unplaced.push(line)
  }
  const article = `# ${production.title}\n\n${sections.join('\n')}${unplaced.join('')}\n`
  await writeFile(join(target, names.script), article)
  files.push(names.script)

  if (shots.length) {
    const seconds = value => (value === undefined || value === null ? '' : en ? `${value}s` : `${value} 秒`)
    const rows = shots.map(({ shot, file }, i) => `| ${i + 1} | ${cell(shot.shot)} | ${seconds(shot.seconds)} | ${cell(shot.visual)} | ${cell(shot.voice)} | ${file ? `![](${file})` : ''} |`)
    const heading = en ? `# ${production.title}: storyboard\n\n| Shot | Size | Length | Visual | Voice-over | Frame |` : `# ${production.title}：分镜头脚本\n\n| 镜号 | 景别 | 时长 | 画面 | 口播 | 分镜图 |`
    await writeFile(join(target, names.board), `${heading}\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`)
    files.push(names.board)
  }
  const sources = production.sources ?? []
  await writeFile(join(target, 'sources.md'), sources.map(row => `- ${row.title}: ${row.reference} (${row.date}) — ${row.limitations}`).join('\n') + '\n', { flag: 'wx' })
  files.push('sources.md')
  manifest.articleSha256 = fingerprint(Buffer.from(production.article ?? ''))
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  files.push('manifest.json')
  return { path: target, files, missing: manifest.missing }
}
