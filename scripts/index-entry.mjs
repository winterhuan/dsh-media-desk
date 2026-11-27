/** 让已写的 dist-tags 只指向列出的版本；指空了的标签丢掉并提示。 */
export function reconcileDistTags(plugin, versions, warn = console.warn) {
  const tags = plugin['dist-tags']
  if (tags === undefined) return
  const listed = new Set(versions.map(entry => entry.version))
  const kept = {}
  for (const [tag, target] of Object.entries(tags)) {
    if (listed.has(target)) kept[tag] = target
    else warn(`index.json 的 dist-tags.${tag} 指向未列出的 ${target}，已丢弃`)
  }
  if (Object.keys(kept).length === 0) delete plugin['dist-tags']
  else plugin['dist-tags'] = kept
}
