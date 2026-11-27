// 版本提示：问 Host 有没有新版本，有就在顶栏和设置里显出来。
import React from 'react'

const RELEASE_URL = 'https://github.com/winterhuan/dsh-media-desk#readme'
const CACHE_TTL_MS = 60 * 60 * 1000
const RETRY_MS = 30 * 1000
const RETRY_MAX = 5

let cache = null
let inflight = null

function fresh() {
  if (!cache) return false
  return Date.now() - cache.at < (cache.failed ? RETRY_MS : CACHE_TTL_MS)
}

async function fetchVersion() {
  const res = await fetch('media-desk/version', { headers: { 'x-media-desk-lang': document.documentElement.lang || 'zh' } })
  if (!res.ok) throw new Error(`version ${res.status}`)
  return res.json()
}

/** 读一次版本信息：一小时内直接给缓存，失败的下次再来。 */
export async function readVersionInfo() {
  if (fresh()) return cache
  if (!inflight) {
    inflight = fetchVersion()
      .then(info => { cache = { ...info, at: Date.now() } })
      .catch(() => { if (cache) cache = { ...cache, at: Date.now(), failed: true } })
      .finally(() => { inflight = null })
  }
  await inflight
  return cache
}

/** 订阅版本信息；失败时半分钟后再试，最多五次，之后安静下来。 */
export function useVersionInfo() {
  const [info, setInfo] = React.useState(cache)
  React.useEffect(() => {
    let alive = true
    let timer = null
    let tries = 0
    const tick = async () => {
      const next = await readVersionInfo()
      if (!alive) return
      if (next) setInfo(next)
      if ((!next || next.failed) && tries < RETRY_MAX) {
        tries += 1
        timer = setTimeout(tick, RETRY_MS)
      }
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [])
  return info
}

/** 有新版本时打开 fork 的固定 Git 安装说明；没有就返回 null。 */
export function updateUrl(info) {
  return info?.updateAvailable ? RELEASE_URL : null
}
