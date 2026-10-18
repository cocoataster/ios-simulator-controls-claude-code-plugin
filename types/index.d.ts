export type Sim = { udid: string; deviceId: string; name: string; os: string; state: string }

declare module 'claude-code' {
  interface PluginState {
    'sim-controls': { sims: Sim[]; selected: string | null; bundleId: string | null; isBusy: boolean; isRunning: boolean; mcp: string; activity: string; frame: number }
  }
}
