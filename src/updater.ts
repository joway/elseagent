/**
 * updater.ts — 启动时自动检查并更新到最新版本
 *
 * 流程：
 *   1. 从 npm registry 获取最新版本号
 *   2. 与当前版本比较
 *   3. 有更新则运行 npm install -g，完成后重启进程
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { createRequire } from 'module'
import { log } from './logger.js'

const execAsync = promisify(exec)

// 读取当前版本（从 package.json）
const require = createRequire(import.meta.url)
const { name, version: currentVersion } = require('../package.json') as {
  name: string
  version: string
}

/** 从 npm registry 获取最新版本号，超时 5 秒 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json() as { version: string }
    return data.version
  } catch {
    return null
  }
}

/** 简单的语义版本比较，latest > current 返回 true */
function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map(Number)
  const [lMaj, lMin, lPat] = parse(latest)
  const [cMaj, cMin, cPat] = parse(current)
  if (lMaj !== cMaj) return lMaj > cMaj
  if (lMin !== cMin) return lMin > cMin
  return lPat > cPat
}

/** 检查更新，有新版本则安装并重启 */
export async function checkAndUpdate(): Promise<void> {
  log('info', `Current version: ${name}@${currentVersion}`)

  const latest = await fetchLatestVersion()

  if (!latest) {
    log('info', 'Update check skipped (registry unreachable)')
    return
  }

  if (!isNewer(latest, currentVersion)) {
    log('info', `Already up to date (${currentVersion})`)
    return
  }

  log('info', `New version available: ${latest} (current: ${currentVersion}). Updating...`)

  try {
    await execAsync(`npm install -g ${name}@${latest}`)
    log('info', `Updated to ${latest}. Restarting...`)

    // 用同一个可执行文件 + 原始参数重启进程
    const { spawn } = await import('child_process')
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      detached: false,
    })
    child.on('exit', code => process.exit(code ?? 0))
    // 当前进程退出，让子进程接管
    process.exit(0)
  } catch (err: any) {
    log('error', `Auto-update failed: ${err.message}. Continuing with current version.`)
  }
}
