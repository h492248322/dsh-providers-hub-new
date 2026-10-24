import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `plugin-src/client/panel-entry.js` 的源码守卫。
 *
 * ⚠️ 为什么只能做源码文本断言：该模块 import 了 `react` 与 `jet-hub.js`，
 * 而 `react` 在 esbuild 的 `external` 里、由宿主注入（`node_modules` 里没有），
 * 所以 vitest 里 import 不到它。本仓库对客户端模块的守卫一律是这个形态。
 *
 * 这些断言守的是**三条会静默失败的约定**：
 * 1. `main` key 必须无条件注册 —— 少了它宿主 `layout.selectPanel('jet-hub')` 会抛错；
 * 2. `settings.section` 必须按枚举增删 —— 无条件注册就等于两个入口同时存在，
 *    选项语义被破坏；
 * 3. 注销侧栏行时必须撤销选中 —— 否则布局里留着没有入口的 `activePanelId`。
 */

const source = readFileSync(new URL('../../plugin-src/client/panel-entry.js', import.meta.url), 'utf8')

describe('panel-entry 注册器', () => {
  it('导出 registerJetHubPanelEntries', () => {
    expect(source).toContain('export function registerJetHubPanelEntries')
  })

  it('⚠️ main key 无条件注册（关掉入口后宿主 selectPanel 仍会命中它）', () => {
    const start = source.indexOf("ctx.slots.inject('main'")
    expect(start, 'missing main slot injection').toBeGreaterThan(-1)
    // ⚠️ 用 `main` 注册的**闭合处**作结束锚点，不用 `start + 400` 这种魔数窗口
    //    （2026-10-24 复核 M3：往注入块上加几行注释，`if (` 就会被挤出窗口，
    //    断言静默失效；反向同理，块内真加了 `if` 也可能落在窗口外）。
    //    ⚠️ 不能用「下一个 ctx.inject」作锚点 —— 紧随其后的 `ctx.inject(['layout']`
    //    回调里本来就有一个 `if`，那样锚点会把无关代码算进来（实测假红）。
    const end = source.indexOf('}, JetHubMainPanel))', start)
    expect(end, '找不到 main 注册的闭合处').toBeGreaterThan(start)
    const block = source.slice(start, end)
    // 该注入块里不得出现条件判断：它必须读一次值就注册。
    expect(block).not.toMatch(/\bif\s*\(/)
    expect(block).toContain('JET_HUB_PANEL_KEY')
  })

  it('两个入口槽位都存在', () => {
    expect(source).toContain("'sidebar.panellist'")
    expect(source).toContain("'settings.section'")
  })

  /**
   * ⚠️⚠️ **槽位 ↔ 判据的配对**（2026-10-24 审计 M2，接线零覆盖）。
   *
   * 原来这条只断言两个函数名**出现在文件里**：
   *   `expect(source).toContain('panelEntryShowsSidebar()')`
   *   `expect(source).toContain('panelEntryShowsSettings()')`
   * ⇒ 把两处槽位的判据**整块互换**后，两个字符串各出现 2 次、依然都在，
   * **全量 10576 条测试全绿**，而语义整个反向：选「仅侧栏」注册的是设置节、
   * 选「仅设置页」注册的是侧栏行。
   *
   * ⇒ 判据必须**按槽位分块**，块内只许出现自己那个。
   */
  it('⚠️⚠️ 每个槽位块内只用**自己**的判据（防两处整块互换）', () => {
    /** 切出 `ctx.slots.inject('<slot>'` 到下一个槽位/函数尾之间的正文。 */
    const blockOf = (slot: string, nextSlot: string | null): string => {
      const start = source.indexOf(`ctx.slots.inject('${slot}'`)
      expect(start, `找不到槽位注入 ${slot}`).toBeGreaterThan(-1)
      const end = nextSlot === null
        ? source.indexOf('\n}', start)
        : source.indexOf(`ctx.slots.inject('${nextSlot}'`, start + 1)
      expect(end, `找不到 ${slot} 块尾`).toBeGreaterThan(start)
      return source.slice(start, end)
    }

    const sidebarBlock = blockOf('sidebar.panellist', 'settings.section')
    const settingsBlock = blockOf('settings.section', null)

    expect(sidebarBlock, 'sidebar.panellist 块内必须调用 panelEntryShowsSidebar()')
      .toContain('panelEntryShowsSidebar()')
    expect(sidebarBlock, 'sidebar.panellist 块内**不得**出现 panelEntryShowsSettings()')
      .not.toContain('panelEntryShowsSettings()')

    expect(settingsBlock, 'settings.section 块内必须调用 panelEntryShowsSettings()')
      .toContain('panelEntryShowsSettings()')
    expect(settingsBlock, 'settings.section 块内**不得**出现 panelEntryShowsSidebar()')
      .not.toContain('panelEntryShowsSidebar()')
  })

  /**
   * ⚠️⚠️ **注册当下必须同步一次**（2026-10-24 审计 M1，P1 真缺陷）。
   *
   * 原实现两处槽位都**不在** `inject` 回调里调 `sync()`，只靠 ①订阅回调
   * ②`loadPanelEntry().then(...)`。读值未 settle 前 `sync` 从未被调用
   * ⇒ **两处入口一个都不注册**（界面空白）。而 `readSignal()` 在缺
   * `AbortSignal.timeout` 时曾返回 `undefined`（target chrome100）⇒ 读取可无限悬挂。
   *
   * ⚠️ 判据必须锚定「`sync(...)` 是 inject 回调里的**顶层语句**」，不能只查
   *    「块内出现过 `sync(`」—— 那在 `.then(() => sync(...))` 里也有。
   */
  it('⚠️⚠️ 两处槽位在注册当下都先同步一次（读值悬挂时也有入口）', () => {
    for (const slot of ['sidebar.panellist', 'settings.section']) {
      const start = source.indexOf(`ctx.slots.inject('${slot}'`)
      expect(start, `找不到 ${slot}`).toBeGreaterThan(-1)
      const body = source.slice(start, source.indexOf('\n  });', start))
      // 顶层调用形态：行首缩进 + `sync(panelEntryShows...)` + 分号，且不在 `.then(` 里。
      const topLevel = /^\s{4}sync\(panelEntryShows(Sidebar|Settings)\(\)\);/m.test(body)
      expect(topLevel, `${slot} 的 inject 回调里没有顶层 sync(...) —— 读值悬挂时该入口不会出现`)
        .toBe(true)
    }
  })

  it('⚠️ 注销侧栏行时必须撤销选中（否则布局留着没有入口的 activePanelId）', () => {
    expect(source).toContain('deselectIfActive')
  })

  /**
   * ⚠️ **`main` 无条件注册**（2026-10-24 审计 M6）。
   *
   * 原判据只查「`ctx.slots.inject('main'` 到 `}, JetHubMainPanel))` 之间没有 `if`」。
   * 把条件包在**语句前面**（`if (…) ctx.slots.inject('main', …)`）就落在窗口外
   * ⇒ 实测 6/6 全绿，而后果可证：条件成立前 `main` 未注册，宿主
   * `layout.selectPanel('jet-hub')` 会抛 `main panel "jet-hub" is not registered`。
   *
   * ⇒ 判据改成**语句级**：全文件该注入只出现一次，且它前面紧邻的不是 `if`。
   */
  it('⚠️ main 注入不得被任何条件包裹（语句级判据）', () => {
    const occurrences = [...source.matchAll(/ctx\.slots\.inject\('main'/g)]
    expect(occurrences, 'main 注入出现了多次').toHaveLength(1)
    const at = occurrences[0].index ?? -1
    expect(at).toBeGreaterThan(-1)
    // 往前取一整行 + 上一行，确认没有被 `if (` / `&&` / `?:` 包住。
    const lineStart = source.lastIndexOf('\n', at) + 1
    const prevLineStart = source.lastIndexOf('\n', lineStart - 1) + 1
    const context = source.slice(prevLineStart, at)
    expect(context, `main 注入被条件包裹了：…${context.trim()}…`)
      .not.toMatch(/(\bif\s*\(|&&|\?[^:]*:|else\b)/)
  })

  it('模块级不再持有旧名字的导出', () => {
    expect(source).not.toContain('registerJetHubSidebarEntry')
    expect(source).not.toContain('sidebar-entry-store.js')
    expect(source).not.toContain('sidebarEntryVisible')
  })
})
