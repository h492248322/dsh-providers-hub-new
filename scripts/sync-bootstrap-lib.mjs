// 把构建产物（`lib/`）同步进 bootstrap 发布目录。
//
// ## 为什么需要这一步（2026-10-24 事故）
//
// `tsc` 的 outDir 是 `lib/`，客户端 esbuild 也输出到 `lib/client/jet-hub.js`，
// 但发布产物在 `dist/bootstrap/dsh-providers-hub-*/plugin/lib/` —— **两者之间没有
// 任何脚本负责同步**。结果是：`npm run build:all` 显示成功（exit 0），产物却一直
// 停留在上一次手工拷贝的时间（实测停了 2 天）。
//
// 更糟的是它没有显而易见的表现：打增量包时 `build-incremental.mjs` 会照常从产物
// 目录取文件，打出一个**看起来成功、实际不含任何新代码**的包。这次就是这样打出了
// 一个只含客户端的 686 KB 包，而服务端改动全在里面缺席。
//
// ## 覆盖范围
//
// 递归同步 `lib/` 下**全部**文件。之所以敢全量覆盖，是因为客户端 bundle 也是先写
// `lib/client/jet-hub.js`、再由本脚本搬过去的 —— 不存在「产物里有、lib 里没有的
// 独特文件」（那条假设已核对：反向差异为 0）。
//
// ⚠️ **只新增与覆盖，绝不删除**：产物里可能有历史遗留文件，误删的代价远大于残留。
// 若 `lib/` 里删掉了某个模块，产物会残留一份旧文件，这种情况在输出里提示。
//
// ## 产物目录缺失时
//
// 首次构建（还没跑过 `service.bat package -Mode bootstrap`）时 `dist/bootstrap`
// 不存在 —— 那是**正常**情况，打印提示并以 0 退出，不阻断构建。
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')

const SRC = resolve(packageRoot, 'lib')
const BOOTSTRAP_ROOT = resolve(packageRoot, 'dist/bootstrap')
const BUNDLE_PREFIX = 'dsh-providers-hub-'

/** 递归列出 `dir` 下所有文件的绝对路径。 */
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** 定位产物里的 `plugin/lib` 目录；找不到返回 undefined。 */
function pluginLibOf(bundleDir) {
  const candidate = join(bundleDir, 'plugin', 'lib')
  return existsSync(candidate) ? candidate : undefined
}

async function syncBundle(bundleDir) {
  const dest = pluginLibOf(bundleDir)
  if (dest === undefined) {
    console.log(`[sync] 跳过（无 plugin/lib）：${relative(packageRoot, bundleDir)}`)
    return undefined
  }

  const sources = await walk(SRC)
  let copied = 0
  let skipped = 0
  for (const from of sources) {
    const rel = relative(SRC, from)
    const to = join(dest, rel)
    await mkdir(dirname(to), { recursive: true })
    // 尺寸 + 修改时间都相同 ⇒ 没变，跳过（避免无谓写盘、也让统计有意义）。
    if (existsSync(to)) {
      const [a, b] = await Promise.all([stat(from), stat(to)])
      if (a.size === b.size && a.mtimeMs === b.mtimeMs) { skipped++; continue }
    }
    await copyFile(from, to)
    copied++
  }

  // 残留检查：产物里有、lib 里没有的文件（不删，只报告）。
  const srcRel = new Set(sources.map((f) => relative(SRC, f)))
  const stale = (await walk(dest))
    .map((f) => relative(dest, f))
    .filter((rel) => !srcRel.has(rel))

  return { bundle: relative(packageRoot, bundleDir), total: sources.length, copied, skipped, stale }
}

async function main() {
  if (!existsSync(SRC)) throw new Error(`缺少构建产物 ${SRC} —— 先跑 tsc`)

  if (!existsSync(BOOTSTRAP_ROOT)) {
    console.log('[sync] 未找到 dist/bootstrap —— 首次构建属正常，跳过同步。')
    console.log('       生成产物后本步会自动生效：service.bat package -Mode bootstrap')
    return
  }

  const bundles = (await readdir(BOOTSTRAP_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith(BUNDLE_PREFIX))
    .map((e) => join(BOOTSTRAP_ROOT, e.name))

  if (bundles.length === 0) {
    console.log(`[sync] ${relative(packageRoot, BOOTSTRAP_ROOT)} 下没有 ${BUNDLE_PREFIX}* 目录，跳过同步。`)
    return
  }
  if (bundles.length > 1) {
    console.log(`[sync] 注意：发现 ${bundles.length} 个产物目录，将全部同步。`)
  }

  let totalCopied = 0
  for (const bundle of bundles) {
    const r = await syncBundle(bundle)
    if (r === undefined) continue
    totalCopied += r.copied
    console.log(`[sync] ${r.bundle}：更新 ${r.copied}，未变 ${r.skipped}（共 ${r.total}）`)
    if (r.stale.length > 0) {
      console.log(`       残留 ${r.stale.length} 个 lib 中已不存在的文件（未删除）：`
        + r.stale.slice(0, 5).join(', ') + (r.stale.length > 5 ? ' …' : ''))
    }
  }

  console.log(`[sync] done. 共更新 ${totalCopied} 个文件。`)
  if (totalCopied === 0) console.log('       （全部已是最新 —— 若刚改过 src，请确认 tsc 已跑）')
}

await main()
