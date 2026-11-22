// 抓取网页和个人主页的公开信息。只读公开 HTML，不登录，也不绕过平台限制。
import { assertPublicUrl as validatePublicUrl } from '../skills/image-generation/scripts/public-url.mjs'
import { tr } from './i18n.js'

const MAX_BYTES = 1_500_000
const TIMEOUT_MS = 8000
const MAX_REDIRECTS = 4

/** 粘贴的链接可能来自任何地方，不能让它访问本机或内网服务。 */
export function assertPublicUrl(raw) { return validatePublicUrl(raw, tr) }

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (all, name) => named[name.toLowerCase()] ?? all)
    .trim()
}

function meta(html, names) {
  for (const name of names) {
    const a = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)
    if (a?.[1]) return decodeEntities(a[1])
    const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i').exec(html)
    if (b?.[1]) return decodeEntities(b[1])
  }
  return null
}

function followerHint(text) {
  const m = /([\d.,]+)\s*(万|千|k|K|m|M)?\s*(?:粉丝|关注者|followers)/.exec(text) ?? /(?:粉丝|followers)[^\d]{0,6}([\d.,]+)\s*(万|千|k|K|m|M)?/.exec(text)
  if (!m) return null
  const unit = { 万: 1e4, 千: 1e3, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[m[2]] ?? 1
  const value = Number(m[1].replace(/,/g, '')) * unit
  return Number.isFinite(value) ? Math.round(value) : null
}

async function fetchPublic(raw, fetchImpl, signal) {
  let current = raw
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicUrl(current)
    signal?.throwIfAborted()
    const res = await fetchImpl(url, {
      redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]),
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), url).toString()
      continue
    }
    return { res, url }
  }
  throw new Error(tr('跳转次数过多'))
}

async function readHtml(raw, fetchImpl, signal) {
  const { res, url } = await fetchPublic(raw, fetchImpl, signal)
  if (!res.ok) throw new Error(tr('页面返回 {status}，可能需要登录或被平台拦截', { status: res.status }))
  const type = res.headers.get('content-type') || ''
  if (!/html|xml/i.test(type)) throw new Error(tr('这不是网页（{type}）', { type: type || tr('未知类型') }))
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  await reader.cancel().catch(() => {})
  return { html: Buffer.concat(chunks).toString('utf8'), url }
}

/**
 * 抓一个公开页面的正文，用来提炼风格。
 * @param {string} raw - 页面地址。
 * @param {typeof fetch} [fetchImpl] - 便于测试替换。
 * @returns {Promise<{url: string, title: string|null, text: string}>} 页面文字。
 */
export async function harvestText(raw, fetchImpl = fetch, signal) {
  const { html, url } = await readHtml(raw, fetchImpl, signal)
  const title = meta(html, ['og:title']) ?? decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '')
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(body).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(line => line.length > 8).join('\n')
  return { url: url.toString(), title: title || null, text }
}

/**
 * 读取一个公开页面的标题、简介、封面和可见的粉丝数。
 * @param {string} raw - 页面地址。
 * @param {typeof fetch} [fetchImpl] - 便于测试替换。
 * @returns {Promise<{url: string, title: string|null, description: string|null, image: string|null, siteName: string|null, followers: number|null}>} 页面信息。
 */
export async function harvest(raw, fetchImpl = fetch, signal) {
  const { html, url } = await readHtml(raw, fetchImpl, signal)
  const title = meta(html, ['og:title', 'twitter:title']) ?? decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '')
  const description = meta(html, ['og:description', 'description', 'twitter:description'])
  let image = meta(html, ['og:image', 'twitter:image', 'og:image:url'])
  if (image) {
    try {
      image = new URL(image, url).toString()
      if (!/^https?:/.test(image)) image = null
    } catch {
      image = null
    }
  }
  const siteName = meta(html, ['og:site_name']) ?? url.hostname.replace(/^www\./, '')
  return { url: url.toString(), title: title || null, description, image, siteName, followers: followerHint(`${description ?? ''} ${html.slice(0, 200000).replace(/<[^>]+>/g, ' ')}`) }
}
