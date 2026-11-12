// 自我强化：从真实数据和你对草稿的修改里提炼规则，确认后才生效，并可导出成 DeepSeek Harness Skill。
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { activeStyle, styleToVoice } from './style.js'
import { platformName, tr } from './i18n.js'

/** 按这台电脑的时区算日期，北京时间早上发的内容不会算到前一天。 */
function localDay(iso) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (row[key] || 0), 0)
}

/** 每篇内容的累计数据。 */
function itemTotals(state) {
  const totals = new Map()
  for (const metric of state.metrics) {
    if (!metric.itemId) continue
    const entry = totals.get(metric.itemId) ?? { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 }
    for (const key of Object.keys(entry)) entry[key] += metric[key] || 0
    totals.set(metric.itemId, entry)
  }
  return totals
}

/** 有了真实数据后，示例数据就不再参与统计。 */
function realMetrics(state) {
  const real = state.metrics.filter(metric => !metric.sample)
  return real.length ? real : state.metrics
}

function engagement(row) {
  return (row.likes || 0) + (row.comments || 0) + (row.shares || 0) + (row.saves || 0)
}

/**
 * 面向复盘页的汇总。
 * @param {object} state - 当前状态。
 * @returns {object} 概览、趋势、平台分布、排行与角度×人物覆盖。
 */
export function computeInsights(state) {
  const metrics = realMetrics(state)
  const onlyReal = metrics.length !== state.metrics.length || !metrics.some(metric => metric.sample)
  const totals = itemTotals({ metrics })
  const daily = new Map()
  for (const metric of metrics) {
    const day = localDay(metric.date)
    const entry = daily.get(day) ?? { date: day, views: 0, engaged: 0 }
    entry.views += metric.views || 0
    entry.engaged += engagement(metric)
    daily.set(day, entry)
  }
  const platforms = new Map()
  for (const metric of metrics) {
    const entry = platforms.get(metric.platform) ?? { platform: metric.platform, views: 0, engaged: 0, likes: 0, comments: 0, shares: 0, saves: 0 }
    for (const key of ['views', 'likes', 'comments', 'shares', 'saves']) entry[key] += metric[key] || 0
    entry.engaged += engagement(metric)
    platforms.set(metric.platform, entry)
  }
  const top = state.items
    .filter(item => totals.has(item.id))
    .map(item => ({ id: item.id, title: item.title, platform: item.platform, ...totals.get(item.id), engaged: engagement(totals.get(item.id)) }))
    .sort((a, b) => (b.views - a.views) || (b.engaged - a.engaged))
  const views = sum(metrics, 'views')
  const engaged = metrics.reduce((total, metric) => total + engagement(metric), 0)
  // 互动率只算读得到播放量的内容，否则分子分母对不上
  const withViews = metrics.filter(metric => metric.views > 0)
  const accounts = state.accounts.filter(account => (onlyReal ? !account.sample : true))
  return {
    views, engaged, engagementRate: views ? withViews.reduce((total, metric) => total + engagement(metric), 0) / views : 0,
    published: state.items.filter(item => item.status === 'published' && (onlyReal ? !item.sample : true)).length,
    followers: sum(accounts, 'followers'), daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)), platforms: [...platforms.values()].sort((a, b) => (b.views - a.views) || (b.engaged - a.engaged)), top,
    hasSample: metrics.some(metric => metric.sample),
  }
}

function slug(text, fallback) {
  const ascii = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return ascii || fallback
}

/**
 * 把生效中的规则写成一个 DeepSeek Harness 用户级 Skill（<home>/skills/<name>/SKILL.md）。
 * 内容由用户在界面确认后点击导出才写入。
 * @param {object} state - 当前状态。
 * @param {string} home - DSH_HOME。
 * @returns {Promise<{name: string, path: string, rules: number}>} 写入结果。
 */
export async function exportSkill(state, home) {
  // 示例规则不是作者的风格，不能写进真实 Skill
  const rules = state.skills.filter(skill => !skill.sample && (skill.status === 'active' || skill.status === 'exported'))
  const picked = activeStyle(state)
  const style = picked && !picked.preset ? picked : null
  const name = 'media-desk-voice'
  const dir = join(home, 'skills', name)
  if (!rules.length && !style) {
    // 之前导出过的旧 Skill 不再代表现在的设置，撤掉它
    await rm(dir, { recursive: true, force: true })
    throw Object.assign(new Error(tr('还没有你自己的风格或规则。示例规则和模板不会被导出')), { status: 400 })
  }
  await mkdir(dir, { recursive: true })
  const description = tr('作者的自媒体写作风格和规则。写选题、脚本、标题或封面文案时使用。')
  const styleBlock = style ? `## ${tr('风格：{name}', { name: style.name })}\n\n${styleToVoice(style)}\n\n` : ''
  const ruleBlock = rules.length ? `## ${tr('必须遵守的规则')}\n\n${rules.map(r => `- **${r.name}**${tr('：')}${r.rule}${r.evidence ? tr('（依据：{evidence}）', { evidence: r.evidence }) : ''}`).join('\n')}\n` : ''
  const body = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${tr('自媒体写作风格')}\n\n${tr('由「自媒体工作台」沉淀，更新于 {date}。', { date: new Date().toISOString().slice(0, 10) })}\n\n${styleBlock}${ruleBlock}`
  await writeFile(join(dir, 'SKILL.md'), body)
  return { name, path: join(dir, 'SKILL.md'), rules: rules.length, slug: slug(name, 'media-desk') }
}
