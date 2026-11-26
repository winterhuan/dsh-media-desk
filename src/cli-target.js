/** Discover the existing service without starting a Host or creating storage. */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

async function optionalJson(file) {
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

/** @param {string} file - Service log. @param {string} [base] - Required origin. @returns {Promise<string|null>} Last matching login URL. */
export async function readLoginUrl(file, base) {
  const text = await readFile(file, 'utf8')
  const urls = text.match(/https?:\/\/[^\s]+\/\?token=[A-Za-z0-9_-]+/g) ?? []
  return urls.filter(url => !base || new URL(url).origin === new URL(base).origin).at(-1) ?? null
}

/**
 * Resolve explicit overrides or the dsh-sre service record for an installed Media Desk profile.
 * @param {object} values - url, profile and login-log CLI options.
 * @param {object} [environment] - Platform, DSH root and login URL; injectable for cross-platform tests.
 * @returns {Promise<{base: string, logFile?: string}>} Existing Host target, never an offline fallback.
 */
export async function resolveHostTarget(values, { platform = process.platform, root = process.env.DSH_HOME || join(homedir(), '.dsh'), loginUrl = process.env.MEDIA_DESK_LOGIN_URL } = {}) {
  const logFile = values['login-log'] && resolve(values['login-log'])
  let base = values.url && new URL(values.url).origin
  if (!base && logFile) {
    const login = await readLoginUrl(logFile)
    if (!login) throw new Error('No login URL in --login-log')
    base = new URL(login).origin
  }
  if (!base && loginUrl && !values.profile) base = new URL(loginUrl).origin
  if (base && (logFile || loginUrl) && !values.profile) return { base, logFile }
  if (values.profile && !/^[\w-]+$/.test(values.profile)) throw new Error('Invalid profile name')
  if (platform === 'win32') {
    const config = await optionalJson(join(root, 'services/windows-config.json'))
    const profiles = values.profile ? [values.profile] : config?.dailyProfiles ?? []
    const targets = []
    for (const profile of profiles) {
      if (!/^[\w-]+$/.test(profile)) throw new Error('Invalid profile in Windows service configuration')
      const pkg = await optionalJson(join(root, 'profiles', profile, 'package.json'))
      if (!pkg?.dependencies?.['@winterhuan/dsh-media-desk'] && !pkg?.dependencies?.['dsh-media-desk']) continue
      const record = await optionalJson(join(root, 'services', `windows-${profile}.json`))
      if (!record || record.profile !== profile || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) continue
      const origin = `http://127.0.0.1:${record.port}`
      if (!base || origin === base) targets.push({ base: origin, logFile: logFile ?? join(root, 'logs', `windows-${profile}.log`) })
    }
    if (targets.length > 1) throw new Error('Multiple Media Desk services found; select --profile or --url with --login-log')
    if (targets.length === 1) return targets[0]
    if (base && !values.profile) return { base, logFile }
    throw new Error('No managed Media Desk service found; start its profile with dsh-sre, or set --url and --login-log. Offline use requires --mode standalone')
  }
  if (values.profile && values.profile !== 'media') throw new Error('Use --url and --login-log for a custom profile on this platform')
  base ??= 'http://127.0.0.1:3085'
  if (logFile || base !== 'http://127.0.0.1:3085') return { base, logFile }
  const directory = join(root, 'installations/dsh-media/.artifacts')
  let logs
  try { logs = await readdir(directory) }
  catch (error) { if (error.code !== 'ENOENT') throw error; logs = [] }
  const latest = logs.filter(name => /^dsh-media-.*\.log$/.test(name)).sort().at(-1)
  return { base, logFile: latest && join(directory, latest) }
}
