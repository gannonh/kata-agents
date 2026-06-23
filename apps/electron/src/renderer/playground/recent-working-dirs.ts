export type RecentDirScenario = 'none' | 'few' | 'many'

const RECENT_DIR_SCENARIO_DATA: Record<RecentDirScenario, string[]> = {
  none: [],
  few: [
    '/Users/demo/projects/kata-agent',
    '/Users/demo/projects/kata-agent/apps/electron',
    '/Users/demo/projects/kata-agent/packages/shared',
  ],
  many: [
    '/Users/demo/projects/kata-agent',
    '/Users/demo/projects/kata-agent/apps/electron',
    '/Users/demo/projects/kata-agent/apps/viewer',
    '/Users/demo/projects/kata-agent/apps/cli',
    '/Users/demo/projects/kata-agent/packages/shared',
    '/Users/demo/projects/kata-agent/packages/server-core',
    '/Users/demo/projects/kata-agent/packages/pi-agent-server',
    '/Users/demo/projects/kata-agent/packages/ui',
    '/Users/demo/projects/kata-agent/scripts',
  ],
}

/** Return a copy of the fixture list for the selected scenario. */
export function getRecentDirsForScenario(scenario: RecentDirScenario): string[] {
  return [...RECENT_DIR_SCENARIO_DATA[scenario]]
}
