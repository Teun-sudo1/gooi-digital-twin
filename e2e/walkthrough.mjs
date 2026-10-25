#!/usr/bin/env node
/*
 * Browser walkthrough of the production build, the way a visitor uses it:
 * the tour, the simulation controls and day chart, map modes and every
 * layer switch, tree opacity and weather, closing a road and restoring it,
 * following a vehicle, moving with the keyboard, search, frame rate, and
 * the phone layout. Any console error fails the run.
 *
 *   npm run check:e2e                  # builds, serves the build and walks through it
 *   node e2e/walkthrough.mjs --url https://teun-sudo1.github.io/gooi-digital-twin/
 *
 * Screenshots and a report go to e2e-output/. Needs a GPU for WebGL
 * (Chromium is started with Metal on macOS).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const OUT = resolve(ROOT, 'e2e-output')
const PORT = 4173
/** A street-level view of a busy main road in Huizen (Stichtseweg × Randweg). */
const STREET_VIEW = '#18/52.28160/5.26650/0/0'

const argUrl = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : null
const results = []
const consoleErrors = []

function run(command, args) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' })
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${command} ${args.join(' ')} exited with ${code}`))))
  })
}

async function serve() {
  await run('npx', ['vite', 'build', '--logLevel', 'warn'])
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
  const url = `http://localhost:${PORT}/gooi-digital-twin/`
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return { url, stop: () => server.kill() }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  server.kill()
  throw new Error('The preview server did not start')
}

/** Runs one check; `warn` turns a failure into a warning (for things outside our control). */
async function step(name, fn, { warn = false } = {}) {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ name, status: 'pass', detail: detail ?? '', ms: Date.now() - started })
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`)
  } catch (error) {
    results.push({ name, status: warn ? 'warn' : 'fail', detail: error.message.split('\n')[0], ms: Date.now() - started })
    console.log(`  ${warn ? '!' : '×'} ${name}: ${error.message.split('\n')[0]}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function openPage(browser, url, { viewport = { width: 1440, height: 900 }, mobile = false, skipTour = true } = {}) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 })
  if (skipTour) await context.addInitScript(() => localStorage.setItem('gooi-tour-seen', '1'))
  const page = await context.newPage()
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${m.text()} (${page.url()})`))
  page.on('pageerror', (e) => consoleErrors.push(`${e.message} (${page.url()})`))
  await page.goto(url)
  await page.waitForFunction(() => document.querySelector('.sim-time')?.textContent !== '--:--', null, { timeout: 90_000 })
  return page
}

const clockText = (page) => page.$eval('.sim-time', (e) => e.textContent)
const shot = (page, name) => page.screenshot({ path: resolve(OUT, `${name}.png`) })

async function openLayers(page) {
  if (!(await page.$('#layer-list'))) await page.click('.layer-panel .panel-header')
}

/** Moves the pointer outwards from the map centre until `found` holds; returns the point or null. */
async function searchMap(page, found, { click = false, tries = 80 } = {}) {
  const { width, height } = page.viewportSize()
  const cx = width / 2
  const cy = height / 2
  for (let i = 0; i < tries; i++) {
    const angle = i * 2.4
    const radius = 6 * Math.sqrt(i) * 6
    const x = cx + Math.cos(angle) * radius
    const y = cy + Math.sin(angle) * radius
    await page.mouse.move(x, y)
    if (click) await page.mouse.click(x, y)
    await page.waitForTimeout(click ? 250 : 60)
    if (await found()) return { x, y }
  }
  return null
}

async function desktop(browser, url) {
  console.log('Desktop')
  // The tour, on a first visit.
  {
    const page = await openPage(browser, url, { skipTour: false })
    await step('tour opens on a first visit', async () => {
      await page.waitForSelector('.tour-card', { timeout: 10_000 })
    })
    await step('tour: every step shows, and points at its part of the screen', async () => {
      const titles = []
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(400)
        titles.push(await page.$eval('#tour-title', (e) => e.textContent))
        const spot = await page.$('.tour-spotlight')
        if (spot) {
          const box = await spot.boundingBox()
          assert(box.width > 20 && box.height > 20, `spotlight of "${titles.at(-1)}" is empty`)
        }
        await shot(page, `tour-${i + 1}`)
        const next = await page.$eval('.tour-next', (e) => e.textContent)
        await page.click('.tour-next')
        if (next === 'Done') break
      }
      assert(!(await page.$('.tour-card')), 'the tour did not close after the last step')
      return `${titles.length} steps`
    })
    await step('tour stays closed after a reload, and the ? button starts it again', async () => {
      await page.reload()
      await page.waitForTimeout(4000)
      assert(!(await page.$('.tour-card')), 'the tour opened again')
      await page.click('button[aria-label="Take the tour"]')
      await page.waitForSelector('.tour-card')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      assert(!(await page.$('.tour-card')), 'Escape did not close the tour')
    })
    await page.context().close()
  }

  const page = await openPage(browser, url)

  await step('the simulation runs, and pause stops the clock', async () => {
    await page.click('.segmented button:has-text("20×")')
    const a = await clockText(page)
    await page.waitForTimeout(3500)
    const b = await clockText(page)
    assert(a !== b, `the clock stayed at ${a}`)
    await page.click('.play-button')
    await page.waitForTimeout(1000)
    const c = await clockText(page)
    await page.waitForTimeout(2500)
    assert(c === (await clockText(page)), 'the clock moved while paused')
    await page.click('.play-button')
    const cars = await page.$eval('.stats dd', (e) => Number(e.textContent.replace(/\D/g, '')))
    assert(cars > 0, 'no cars in the statistics')
    return `${a} → ${b}, ${cars} cars`
  })

  await step('the time-of-day slider jumps to the morning rush', async () => {
    const box = await page.$eval('.sim-timeline input', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    await page.mouse.click(box.x + 8 + ((box.w - 16) * 480) / 1439, box.y + box.h / 2)
    await page.waitForTimeout(1500)
    const time = await clockText(page)
    assert(/^0[78]:/.test(time), `the clock shows ${time}`)
    return time
  })

  await step('the day chart shows simulated values and the expected demand', async () => {
    await page.waitForSelector('.trend .trend-line', { timeout: 15_000 })
    assert(await page.$('.trend .trend-expected'), 'no expected-demand line')
    assert((await page.$$('.trend-legend li')).length >= 2, 'no chart legend')
  })

  await step('map modes switch the map and its layers', async () => {
    await openLayers(page)
    const checked = (label) => page.locator('label.toggle', { hasText: label }).locator('input').isChecked()
    await page.click('.map-mode:has-text("Driving")')
    assert(await checked('Congestion'), 'Driving does not show congestion')
    await page.click('.map-mode:has-text("Transit")')
    assert(await checked('Transit routes & stops'), 'Transit does not show routes')
    await page.click('.map-mode:has-text("Satellite")')
    await page.waitForTimeout(1500)
    await shot(page, 'mode-satellite')
    await page.click('.map-mode:has-text("Explore")')
    assert(!(await checked('Congestion')), 'Explore still shows congestion')
  })

  await step('every layer switch turns off and on again', async () => {
    await openLayers(page)
    const labels = await page.$$eval('#layer-list label.toggle', (els) => els.map((e) => e.textContent.trim()))
    for (const label of labels) {
      const toggle = page.locator('#layer-list label.toggle', { hasText: label }).first()
      await toggle.scrollIntoViewIfNeeded()
      const before = await toggle.locator('input').isChecked()
      await toggle.click()
      await page.waitForTimeout(250)
      assert((await toggle.locator('input').isChecked()) !== before, `"${label}" did not switch`)
      await toggle.click()
      await page.waitForTimeout(150)
    }
    return `${labels.length} switches`
  })

  await step('traffic lights and lanes switch on and off in the simulation', async () => {
    await openLayers(page)
    for (const label of ['Traffic lights', 'Multiple lanes']) {
      const toggle = page.locator('#layer-list label.toggle', { hasText: label })
      await toggle.scrollIntoViewIfNeeded()
      await toggle.click()
      await page.waitForTimeout(2500)
      await toggle.click()
    }
    // At 20× the clock (hours:minutes) moves a minute every 3 s.
    const before = await clockText(page)
    await page.waitForTimeout(4000)
    assert(before !== (await clockText(page)), 'the simulation stopped')
  })

  await step('tree opacity and weather change the map', async () => {
    await openLayers(page)
    const slider = page.locator('#tree-opacity')
    await slider.scrollIntoViewIfNeeded()
    const box = await slider.boundingBox()
    await page.mouse.click(box.x + box.width * ((40 - 10) / 90), box.y + box.height / 2)
    const value = await page.$eval('#tree-opacity', (e) => Number(e.value))
    assert(value >= 30 && value <= 50, `the slider shows ${value}%`)
    await page.selectOption('#weather-select', 'snow')
    await page.waitForSelector('.weather-overlay.weather-snow')
    await page.selectOption('#weather-select', 'live')
    return `${value}%`
  })

  await step('cinematic flight: choose time and weather, fly, and stop with a key', async () => {
    await page.click('.cinematic-button')
    await page.waitForSelector('.cinematic-setup')
    await page.click('.cinematic-options label:has-text("Evening rush")')
    await page.click('.cinematic-options label:has-text("Rain")')
    await page.click('.cinematic-start')
    await page.waitForSelector('.cinematic-caption', { timeout: 10_000 })
    await page.waitForSelector('.weather-overlay.weather-rain')
    assert((await page.$eval('.sim-bar', (e) => getComputedStyle(e).display)) === 'none', 'the panels stayed visible')
    await page.waitForTimeout(12_000)
    await shot(page, 'cinematic')
    const place = await page.$eval('.cinematic-caption strong', (e) => e.textContent)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    assert(!(await page.$('.cinematic-overlay')), 'Escape did not stop the flight')
    assert((await page.$eval('.sim-bar', (e) => getComputedStyle(e).display)) !== 'none', 'the panels did not come back')
    await page.selectOption('#weather-select', 'live').catch(() => {})
    return place
  })

  // Street level for the road tools, following and frame rate.
  await page.goto(url + STREET_VIEW)
  await page.waitForFunction(() => document.querySelector('.sim-time')?.textContent !== '--:--', null, { timeout: 90_000 })
  await page.waitForTimeout(3000)

  await step('close a road, see the comparison, and restore the original', async () => {
    await page.click('.scenario-panel button:has-text("Close road")')
    const spot = await searchMap(page, async () => Boolean(await page.$('.hover-street')))
    assert(spot, 'no street found under the pointer')
    const street = await page.$eval('.hover-street', (e) => e.textContent)
    await page.mouse.click(spot.x, spot.y)
    await page.waitForSelector('.edit-list li', { timeout: 10_000 })
    await page.keyboard.press('Escape')
    await page.waitForSelector('.comparison', { timeout: 15_000 })
    await shot(page, 'road-closed')
    await page.click('.restore-button')
    await page.waitForSelector('text=No changes yet', { timeout: 10_000 })
    return street
  })

  await step('remove a road completely, and bring it back', async () => {
    await page.click('.scenario-panel button:has-text("Remove road")')
    const spot = await searchMap(page, async () => Boolean(await page.$('.hover-street')))
    assert(spot, 'no street found under the pointer')
    await page.mouse.click(spot.x, spot.y)
    await page.waitForSelector('.edit-list li:has-text("Removed")', { timeout: 10_000 })
    await shot(page, 'road-removed')
    await page.keyboard.press('Escape')
    await page.click('.restore-button')
    await page.waitForSelector('text=No changes yet', { timeout: 10_000 })
  })

  await step('draw a new curved main road between two junctions', async () => {
    await page.click('.scenario-panel button:has-text("New road")')
    await page.click('.road-options button:has-text("Main road")')
    const hint = () => page.$eval('.tool-hint', (e) => e.textContent)
    // Start: click near the centre until a junction is found.
    const { width, height } = page.viewportSize()
    let started = false
    for (let i = 0; i < 40 && !started; i++) {
      const angle = i * 2.4
      const r = 8 * Math.sqrt(i) * 5
      await page.mouse.click(width / 2 + Math.cos(angle) * r, height / 2 + Math.sin(angle) * r)
      await page.waitForTimeout(150)
      started = /add bends/.test(await hint())
    }
    assert(started, 'no junction to start from')
    // A bend, then try finishing (a second click on the same spot) until it lands on a junction.
    await page.mouse.click(width / 2 + 120, height / 2 - 90)
    let finished = false
    for (let i = 0; i < 40 && !finished; i++) {
      const angle = i * 2.4
      const r = 8 * Math.sqrt(i) * 5
      const x = width / 2 + 260 + Math.cos(angle) * r
      const y = height / 2 + 40 + Math.sin(angle) * r
      await page.mouse.click(x, y)
      await page.waitForTimeout(120)
      await page.mouse.click(x, y)
      await page.waitForTimeout(250)
      finished = Boolean(await page.$('.edit-list li:has-text("New main road")'))
      if (!finished) await page.keyboard.press('Backspace')
    }
    assert(finished, 'the road could not be finished on a junction')
    const detail = await page.$eval('.edit-list li', (e) => e.textContent)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(2500)
    await shot(page, 'road-added')
    await page.click('.restore-button')
    await page.waitForSelector('text=No changes yet', { timeout: 10_000 })
    return detail.replace(/×$/, '').trim()
  })

  await step('click a vehicle to follow it, Escape to stop', async () => {
    const hit = await searchMap(page, async () => Boolean(await page.$('.follow-card')), { click: true, tries: 60 })
    assert(hit, 'no vehicle could be clicked near the centre')
    await shot(page, 'follow')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    assert(!(await page.$('.follow-card')), 'Escape did not stop following')
  }, { warn: true })

  await step('W A S D move the map', async () => {
    await page.mouse.click(700, 120)
    const before = await page.evaluate(() => location.hash)
    await page.keyboard.down('d')
    await page.waitForTimeout(700)
    await page.keyboard.up('d')
    await page.waitForTimeout(600)
    const after = await page.evaluate(() => location.hash)
    assert(before !== after, 'the view did not move')
  })

  await step('at least 30 frames per second at street level', async () => {
    const fps = await page.evaluate(
      () =>
        new Promise((done) => {
          let frames = 0
          const start = performance.now()
          const tick = () => {
            frames++
            if (performance.now() - start < 3000) requestAnimationFrame(tick)
            else done(Math.round(frames / 3))
          }
          requestAnimationFrame(tick)
        }),
    )
    assert(fps >= 30, `${fps} fps`)
    return `${fps} fps`
  })

  // Needs PDOK's search service.
  await step('search finds Huizen', async () => {
    await page.fill('input[aria-label="Search address or place"]', 'Huizen')
    await page.waitForSelector('.search-results [role="option"]', { timeout: 10_000 })
    await page.keyboard.press('Escape')
  }, { warn: true })

  await shot(page, 'street-level')
  await page.context().close()
}

async function phone(browser, url) {
  console.log('Phone')
  const page = await openPage(browser, url, { viewport: { width: 390, height: 844 }, mobile: true, skipTour: false })
  await step('phone: the tour opens and can be skipped', async () => {
    await page.waitForSelector('.tour-card', { timeout: 10_000 })
    await shot(page, 'phone-tour')
    await page.click('.tour-skip')
    assert(!(await page.$('.tour-card')), 'the tour stayed open')
  })
  await step('phone: the tabs open and close their sheets', async () => {
    for (const [tab, panel] of [['Stats', '.dashboard'], ['Roads', '.scenario-panel'], ['Layers', '.map-modes']]) {
      await page.click(`.mobile-tabs button:has-text("${tab}")`)
      await page.waitForSelector(`.mobile-sheet ${panel}`, { timeout: 5000 })
      await shot(page, `phone-${tab.toLowerCase()}`)
      await page.click(`.mobile-tabs button:has-text("${tab}")`)
      await page.waitForTimeout(200)
      assert(!(await page.$('.mobile-sheet')), `the ${tab} sheet did not close`)
    }
  })
  await page.context().close()
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const server = argUrl ? null : await serve()
  const url = argUrl ?? server.url
  console.log(`Walking through ${url}`)
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
  try {
    await desktop(browser, url)
    await phone(browser, url)
    await step('no errors in the browser console', async () => {
      assert(consoleErrors.length === 0, `${consoleErrors.length} errors, first: ${consoleErrors[0]}`)
    })
  } finally {
    await browser.close()
    server?.stop()
  }
  const failed = results.filter((r) => r.status === 'fail')
  const warned = results.filter((r) => r.status === 'warn')
  const report = [
    '# Browser walkthrough',
    '',
    `${new Date().toISOString()} · ${url}`,
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.name} | ${r.status} | ${r.detail} |`),
    '',
    ...consoleErrors.map((e) => `- console: ${e}`),
  ].join('\n')
  writeFileSync(resolve(OUT, 'report.md'), report)
  console.log(`walkthrough: ${results.length - failed.length - warned.length} passed, ${failed.length} failed, ${warned.length} warnings (report and screenshots in e2e-output/)`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
