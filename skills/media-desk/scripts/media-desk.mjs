#!/usr/bin/env node
import { main } from '../../../scripts/media-desk-read.mjs'
main().catch(error => { console.error(JSON.stringify({ error: error.message, code: error.code, pendingId: error.pendingId })); process.exitCode = 1 })
