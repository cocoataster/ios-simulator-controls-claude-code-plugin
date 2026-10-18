import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Sim } from '../types'

const sims = atom({ plugin: 'sim-controls', key: 'sims' } as const, [] as Sim[])
const selected = atom({ plugin: 'sim-controls', key: 'selected' } as const, null as string | null)
const bundleId = atom({ plugin: 'sim-controls', key: 'bundleId' } as const, null as string | null)
const isRunning = atom({ plugin: 'sim-controls', key: 'isRunning' } as const, false)
// 'connected' | 'disconnected' | 'unknown' (the check itself could not run)
const mcp = atom({ plugin: 'sim-controls', key: 'mcp' } as const, 'unknown')
// '' | 'run' | 'stop': what the plugin is doing now; frame drives the spinner
const activity = atom({ plugin: 'sim-controls', key: 'activity' } as const, '')
const frame = atom({ plugin: 'sim-controls', key: 'frame' } as const, 0)
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const isBusy = atom({ plugin: 'sim-controls', key: 'isBusy' } as const, false)

// Everything here shells out to xcodebuild / xcrun: no MCP server and no model turn.
const refresh = async ($: EngineInterface) => {
  try {
    const { stdout } = await $.process.run(['xcrun', 'simctl', 'list', 'devices', 'available', '-j'])
    const runtimes = JSON.parse(stdout).devices as Record<string, { udid: string; name: string; state: string }[]>
    const list: Sim[] = []
    for (const [runtime, devices] of Object.entries(runtimes)) {
      if (!runtime.includes('iOS')) continue
      const os = runtime.split('.').pop()!.replace(/^iOS-/, '').replace(/-/g, '.')
      for (const d of devices) list.push({ udid: d.udid, deviceId: d.udid, name: d.name, os, state: d.state })
    }
    list.sort((a, b) => Number(b.state === 'Booted') - Number(a.state === 'Booted') || a.name.localeCompare(b.name))
    await update($, sims, () => list)
    const booted = list.find(x => x.state === 'Booted')
    if (booted && (await read($, selected)) === null) await update($, selected, () => booted.udid)

    // Running = the app Run launched is a live process on the selected, booted simulator.
    const id = await read($, bundleId)
    const chosen = await read($, selected)
    const sim = list.find(x => x.udid === chosen)
    let running = false
    if (id && sim?.state === 'Booted') {
      const { stdout } = await $.process.run(['xcrun', 'simctl', 'spawn', sim.deviceId, 'launchctl', 'list'])
      running = stdout.includes(`UIKitApplication:${id}`)
    }
    if (running !== (await read($, isRunning))) await update($, isRunning, () => running)
  } catch (err) {
    $.ui.log(`sim-controls could not read simulators: ${String(err)}`, { to: 'transcript' })
  }
}

const tail = (text: string, n = 6) => text.trim().split('\n').slice(-n).join('\n')

// Finds the Xcode project of the session's folder (a workspace wins over a project).
const findProject = async ($: EngineInterface, cwd: string) => {
  const { stdout } = await $.process.run(
    ['find', '.', '-maxdepth', '3', '(', '-name', '*.xcworkspace', '-o', '-name', '*.xcodeproj', ')',
     '-not', '-path', '*/.build/*', '-not', '-path', '*/Pods/*', '-not', '-path', '*.xcodeproj/*', '-not', '-path', '*.xcworkspace/*'],
    { cwd },
  )
  const found = stdout.split('\n').map(x => x.trim()).filter(Boolean).sort((a, b) => a.length - b.length)
  const path = found.find(x => x.endsWith('.xcworkspace')) ?? found[0]
  if (!path) return null
  return { path, flag: path.endsWith('.xcworkspace') ? '-workspace' : '-project' }
}

// Builds the project's scheme for the simulator, installs it and launches it.
const run = async ($: EngineInterface, sim: Sim) => {
  const cwd = await $.session.cwd()
  const project = await findProject($, cwd)
  if (!project) {
    $.ui.toast(`No Xcode project found in ${cwd}`)
    return
  }
  const target = [project.flag, project.path]
  const listed = await $.process.run(['xcodebuild', '-list', '-json', ...target], { cwd, timeoutMs: 60_000 })
  const info = JSON.parse(listed.stdout)
  const schemes: string[] = (info.workspace ?? info.project)?.schemes ?? []
  const base = project.path.split('/').pop()!.replace(/\.(xcworkspace|xcodeproj)$/, '')
  const scheme = schemes.find(x => x === base) ?? schemes[0]
  if (!scheme) {
    $.ui.toast(`No scheme in ${project.path}`)
    return
  }

  const destination = ['-destination', `id=${sim.deviceId}`]
  $.ui.status(`Building ${scheme} for ${sim.name}…`)
  const build = await $.process.run(['xcodebuild', ...target, '-scheme', scheme, ...destination, 'build'], { cwd, timeoutMs: 600_000 })
  if (build.exitCode !== 0) {
    const errors = build.stdout.split('\n').filter(l => l.includes('error:')).slice(0, 8).join('\n')
    $.ui.toast(`Build failed (${scheme})`)
    $.ui.log(`sim-controls build failed:\n${errors || tail(build.stdout + build.stderr)}`, { to: 'transcript' })
    return
  }

  const settingsRun = await $.process.run(['xcodebuild', ...target, '-scheme', scheme, ...destination, '-showBuildSettings', '-json'], { cwd, timeoutMs: 120_000 })
  const entry = (JSON.parse(settingsRun.stdout) as { buildSettings: Record<string, string> }[]).find(
    x => x.buildSettings.PRODUCT_TYPE === 'com.apple.product-type.application',
  )
  if (!entry) {
    $.ui.toast(`${scheme} does not build an app`)
    return
  }
  const appPath = `${entry.buildSettings.TARGET_BUILD_DIR}/${entry.buildSettings.FULL_PRODUCT_NAME}`
  const id = entry.buildSettings.PRODUCT_BUNDLE_IDENTIFIER

  if (sim.state !== 'Booted') await $.process.run(['xcrun', 'simctl', 'boot', sim.deviceId])
  await $.process.run(['open', '-a', 'Simulator'])
  $.ui.status(`Installing ${id}…`)
  const install = await $.process.run(['xcrun', 'simctl', 'install', sim.deviceId, appPath])
  if (install.exitCode !== 0) {
    $.ui.toast(`Install failed: ${tail(install.stderr, 2)}`)
    return
  }
  const launch = await $.process.run(['xcrun', 'simctl', 'launch', '--terminate-running-process', sim.deviceId, id])
  if (launch.exitCode !== 0) {
    $.ui.toast(`Launch failed: ${tail(launch.stderr, 2)}`)
    return
  }
  await update($, bundleId, () => id)
  await update($, isRunning, () => true)
  $.ui.toast(`Running ${scheme} on ${sim.name}`)
}

// Xcode MCP health via the CLI's own check. Asking the server through $.mcp.call is
// not an option: auto mode refuses the mod's MCP calls, which read as "disconnected".
const checkMcp = async ($: EngineInterface) => {
  let state = 'unknown'
  try {
    const { exitCode, stdout } = await $.process.run(['/bin/zsh', '-lc', 'claude mcp get xcode'], { timeoutMs: 30_000 })
    const status = /Status:\s*(.*)/.exec(stdout)?.[1] ?? ''
    if (status.includes('Connected')) state = 'connected'
    else if (exitCode === 0 && status) state = 'disconnected'
    else if (exitCode !== 0) state = 'disconnected'
  } catch {
    state = 'unknown'
  }
  if (state !== (await read($, mcp))) await update($, mcp, () => state)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void refresh($)
    void checkMcp($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($)
    void checkMcp($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Select, Text } = $.ui.resolve(e)
    const stored = await read($, sims)
    const list = stored.filter(x => typeof x.deviceId === 'string')
    if (list.length !== stored.length) void refresh($)
    const current = await read($, selected)
    const running = await read($, isRunning)
    const mcpState = await read($, mcp)
    const isLaunching = (await read($, activity)) === 'run'
    const spin = SPINNER[(await read($, frame)) % SPINNER.length]
    const active = list.find(s => s.udid === current) ?? list[0]

    const busy = async (kind: 'run' | 'stop', job: () => Promise<void>) => {
      if (await read($, isBusy)) return
      await update($, isBusy, () => true)
      await update($, activity, () => kind)
      let isSpinning = kind === 'run'
      if (isSpinning) {
        void (async () => {
          while (isSpinning) {
            await $.clock.sleep(100)
            if (isSpinning) await update($, frame, n => n + 1)
          }
        })()
      }
      try {
        await job()
      } catch (err) {
        $.ui.toast('Run failed; see the transcript')
        $.ui.log(`sim-controls: ${String(err)}`, { to: 'transcript' })
      } finally {
        isSpinning = false
        $.ui.status(undefined)
        await update($, activity, () => '')
        await update($, isBusy, () => false)
        await refresh($)
      }
    }

    const onRun = () => {
      if (!active) {
        $.ui.toast('No simulator selected')
        return
      }
      void busy('run', () => run($, active))
    }

    const onStop = () =>
      busy('stop', async () => {
        const id = await read($, bundleId)
        if (!active || !id) {
          $.ui.toast('Nothing launched from here to stop')
          return
        }
        const { exitCode, stderr } = await $.process.run(['xcrun', 'simctl', 'terminate', active.deviceId, id])
        if (exitCode === 0) await update($, isRunning, () => false)
        $.ui.toast(exitCode === 0 ? `Stopped ${id}` : `Stop failed: ${tail(stderr, 2)}`)
      })

    // Boots the chosen simulator with simctl.
    const pick = async (udid: string) => {
      const sim = list.find(x => x.udid === udid)
      if (!sim) {
        $.ui.toast('Simulator not found')
        return
      }
      if (sim.state === 'Booted') {
        $.ui.toast(`${sim.name} is already booted`)
      } else {
        try {
          const { exitCode, stderr } = await $.process.run(['xcrun', 'simctl', 'boot', sim.deviceId])
          $.ui.toast(exitCode === 0 ? `Booted ${sim.name}` : `Boot failed: ${stderr.trim().slice(0, 100)}`)
        } catch (err) {
          $.ui.toast(`Boot failed: ${String(err).slice(0, 100)}`)
        }
      }
      await update($, selected, () => sim.udid)
      await refresh($)
    }

    const options = list.map(s => ({
      value: s.udid,
      label: `${s.state === 'Booted' ? '●' : '○'} ${s.name} · iOS ${s.os} · ${s.state}`,
    }))

    // Rows are set explicitly: the desktop surface stacks a Box's children by default.
    return (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between">
        <Box flexDirection="row" alignItems="center" gap={2}>
          {list.length > 1 ? (
            <Select key="sim" options={options} value={active.udid} onSelect={pick} />
          ) : (
            <Text>{list.length === 1 ? `${list[0].name} · ${list[0].state}` : 'No simulator'}</Text>
          )}
          {mcpState === 'connected' ? <Text color="green">● Xcode MCP</Text> : null}
          {mcpState === 'disconnected' ? <Text color="yellow">○ Xcode MCP not connected</Text> : null}
          {mcpState === 'unknown' ? <Text dimColor>○ Xcode MCP unknown</Text> : null}
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Button key="run" variant="primary" onPress={onRun}>{isLaunching ? `${spin} ${running ? 'Reloading…' : 'Launching…'}` : running ? '↻ Reload' : '▶ Run'}</Button>
          {running ? <Button key="stop" onPress={onStop}>■ Stop</Button> : null}
        </Box>
      </Box>
    )
  })
}
