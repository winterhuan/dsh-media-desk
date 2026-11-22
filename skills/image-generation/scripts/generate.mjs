#!/usr/bin/env node
/** Standalone HTTP image entry; a fresh result directory retains the request status and returned bytes. */
import { parseArgs, parseEnv } from 'node:util'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { generateImage } from './http.mjs'

const { values } = parseArgs({ options: {
  config: { type: 'string' }, 'dotenv': { type: 'string' }, model: { type: 'string' },
  'prompt-file': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('image-generation [--dotenv <.env>] [--model <model>] [--config <private-config.json>] --prompt-file <prompt.txt> --out <new-result-directory>\nDefault: IMAGE_URL and IMAGE_API_KEY from ~/.config/image-generation/.env (or XDG_CONFIG_HOME/image-generation/.env). Project .env or --dotenv overrides global values; exported environment takes precedence. IMAGE_MODEL or --model selects the model (default gpt-image-2). Explicit config overrides the endpoint and key source: baseUrl, model?, size?, quality?, extra?, apiKeyEnv? (default IMAGE_GENERATION_API_KEY) or private apiKey. No DSH or Media Desk dependency.')
} else {
  let receipt, directory, apiKey
  try {
    if (!values['prompt-file'] || !values.out) throw new Error('Provide --prompt-file and --out')
    const globalEnvFile = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'image-generation', '.env')
    const projectEnvFile = resolve(values['dotenv'] ?? '.env')
    let fileEnv = {}
    for (const envFile of [globalEnvFile, projectEnvFile]) {
      try { fileEnv = { ...fileEnv, ...parseEnv(await readFile(envFile, 'utf8')) } } catch (error) {
        if ((values['dotenv'] && envFile === projectEnvFile) || error.code !== 'ENOENT') throw new Error('Cannot read image environment file: ' + envFile)
      }
    }
    const env = { ...fileEnv, ...process.env }
    let config = {}
    if (values.config) {
      const rawConfig = await readFile(resolve(values.config), 'utf8')
      try { config = JSON.parse(rawConfig) } catch { throw new Error('Image configuration must be valid JSON') }
    }
    const prompt = (await readFile(resolve(values['prompt-file']), 'utf8')).trim()
    const image = { ...config,
      baseUrl: values.config ? config.baseUrl : env.IMAGE_URL,
      apiKey: values.config ? env[config.apiKeyEnv ?? 'IMAGE_GENERATION_API_KEY'] ?? config.apiKey : env.IMAGE_API_KEY,
      model: values.model ?? config.model ?? env.IMAGE_MODEL ?? 'gpt-image-2' }
    apiKey = image.apiKey
    if (!image.baseUrl || !image.model || !image.apiKey || !prompt || prompt.length > 20000) throw new Error('Provide IMAGE_URL and IMAGE_API_KEY (or an explicit config), and a prompt of 1–20000 characters')
    const url = new URL(image.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) endpoint without embedded credentials, query or fragment')
    image.baseUrl = image.baseUrl.replace(/\/+$/, '').replace(/\/images\/generations$/, '')
    directory = resolve(values.out)
    await mkdir(directory, { mode: 0o700 })
    receipt = { id: randomUUID(), status: 'prepared', channel: 'http', model: image.model,
      promptSha256: createHash('sha256').update(prompt).digest('hex'), createdAt: new Date().toISOString() }
    await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 })
    const { buffer, ext } = await generateImage(image, prompt)
    const file = join(directory, 'image' + ext)
    receipt.status = 'received'
    await writeFile(file, buffer, { flag: 'wx', mode: 0o600 })
    Object.assign(receipt, { status: 'saved', file, sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length })
    await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ file, receiptFile: join(directory, 'receipt.json'), model: image.model }))
  } catch (error) {
    const message = apiKey ? String(error.message).split(apiKey).join('***') : error.message
    if (receipt) {
      receipt.status = ['received', 'saved'].includes(receipt.status) ? 'save-failed' : 'uncertain'
      receipt.error = message
      try { await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 }) } catch {}
    }
    console.error(JSON.stringify({ error: message, ...(receipt ? { receiptFile: join(directory, 'receipt.json'), status: receipt.status } : {}) }))
    process.exitCode = 1
  }
}
