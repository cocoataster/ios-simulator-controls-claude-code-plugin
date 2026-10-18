import { expect, test } from 'claude-code/testing'

const SIMCTL = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-1': [
      { udid: 'AAAA', name: 'iPhone Alpha', state: 'Shutdown' },
      { udid: 'BBBB', name: 'iPhone Beta', state: 'Booted' },
    ],
    'com.apple.CoreSimulator.SimRuntime.tvOS-27-1': [{ udid: 'TTTT', name: 'Apple TV', state: 'Shutdown' }],
  },
})

// A process.run hook answers with { value }: what the engine would have resolved.
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// The engine's own session start, and a moment for the plugin's background refresh (simctl, claude mcp get) to land.
const start = async ($: any, on: any) => {
  // The spinner sleeps between frames; toasts, status and log lines have no surface here.
  on('clock.sleep', async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { value: undefined } })
  on('session.cwd', () => ({ value: '/tmp/proj' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/tmp' }))
  await $.session.start({ cwd: '/tmp' })
  await new Promise(resolve => setTimeout(resolve, 150))
}

test('lists iOS simulators with state and offers Run', async ($, on) => {
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    if (e.argv.includes('simctl') && e.argv.includes('list')) return ok(SIMCTL)
    return ok('Status: ✔ Connected')
  })

  await start($, on)
  const ui = await $.ui.mount({ plugin: 'sim-controls', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } })

  const picker = await ui.find({ key: 'sim' })
  expect(picker).toBeDefined()
  expect(await ui.find({ key: 'run' })).toBeDefined()
  // Stop only exists while the app is running.
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  // tvOS devices are not listed.
  expect(JSON.stringify(await ui.drawn())).not.toContain('Apple TV')
})

test('picking a shutdown simulator boots it with simctl', async ($, on) => {
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    if (e.argv.includes('simctl') && e.argv.includes('list')) return ok(SIMCTL)
    return ok('Status: ✔ Connected')
  })

  await start($, on)
  await $.ui.mount({ plugin: 'sim-controls', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } })
  await $.ui.select({ plugin: 'sim-controls', key: 'sim', value: 'AAAA' })

  expect(calls.some(c => c.join(' ') === 'xcrun simctl boot AAAA')).toBe(true)
})

test('shows the Xcode MCP status from the CLI check', async ($, on) => {
  on('process.run', ($, e) => {
    if (e.argv.includes('simctl')) return ok(SIMCTL)
    return ok('xcode:\n  Status: ✗ Failed to connect')
  })

  await start($, on)
  const ui = await $.ui.mount({ plugin: 'sim-controls', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } })

  expect(JSON.stringify(await ui.drawn())).toContain('not connected')
})

test('stays out of the way while a survey is showing', async ($, on) => {
  on('process.run', () => ok(SIMCTL))
  // Whatever the plugin passes down is what draws: here, a marker the test owns.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>passed through</Text>
  })
  await start($, on)
  const ui = await $.ui.mount({ plugin: 'sim-controls', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: true } })

  expect(await ui.find({ key: 'run' })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toContain('passed through')
})

test('Run builds the project, installs and launches it; Stop then appears and Run becomes Reload', async ($, on) => {
  const calls: string[] = []
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    calls.push(cmd)
    if (cmd.includes('simctl list')) return ok(SIMCTL)
    if (cmd.startsWith('find')) return ok('./App/App.xcodeproj\n')
    if (cmd.includes('-list -json')) return ok(JSON.stringify({ project: { schemes: ['Other', 'App'] } }))
    if (cmd.includes('-showBuildSettings')) {
      return ok(JSON.stringify([
        { buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.app-extension' } },
        { buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.application', TARGET_BUILD_DIR: '/b', FULL_PRODUCT_NAME: 'App.app', PRODUCT_BUNDLE_IDENTIFIER: 'com.x.app' } },
      ]))
    }
    if (cmd.includes('launchctl list')) return ok('123\t0\tUIKitApplication:com.x.app[abcd]\n')
    return ok('Status: ✔ Connected')
  })

  await start($, on)
  const ui = await $.ui.mount({ plugin: 'sim-controls', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } })
  await ui.press({ key: 'run' })
  await new Promise(resolve => setTimeout(resolve, 300))

  // The scheme named after the project wins; the app target (not the extension) is installed.
  expect(calls.some(c => c.includes('xcodebuild -project ./App/App.xcodeproj -scheme App -destination id=BBBB build'))).toBe(true)
  expect(calls).toContain('xcrun simctl install BBBB /b/App.app')
  expect(calls).toContain('xcrun simctl launch --terminate-running-process BBBB com.x.app')

  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('Reload')
})

test('Stop terminates the app and hides itself', async ($, on) => {
  const calls: string[] = []
  let isAppRunning = false
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    calls.push(cmd)
    if (cmd.includes('simctl list')) return ok(SIMCTL)
    if (cmd.startsWith('find')) return ok('./App.xcodeproj\n')
    if (cmd.includes('-list -json')) return ok(JSON.stringify({ project: { schemes: ['App'] } }))
    if (cmd.includes('-showBuildSettings')) {
      return ok(JSON.stringify([{ buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.application', TARGET_BUILD_DIR: '/b', FULL_PRODUCT_NAME: 'App.app', PRODUCT_BUNDLE_IDENTIFIER: 'com.x.app' } }]))
    }
    if (cmd.includes('simctl launch')) isAppRunning = true
    if (cmd.includes('simctl terminate')) isAppRunning = false
    if (cmd.includes('launchctl list')) return ok(isAppRunning ? '1\t0\tUIKitApplication:com.x.app[a]\n' : '')
    return ok('Status: ✔ Connected')
  })

  await start($, on)
  const ui = await $.ui.mount({ plugin: 'sim-controls', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } })
  await ui.press({ key: 'run' })
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(await ui.find({ key: 'stop' })).toBeDefined()

  await ui.press({ key: 'stop' })
  await new Promise(resolve => setTimeout(resolve, 200))

  expect(calls).toContain('xcrun simctl terminate BBBB com.x.app')
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
})
