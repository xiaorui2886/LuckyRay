type Invoke = (command: string, args: Record<string, unknown>) => Promise<any>;

// Injectable only for contract tests; the runtime supplies Tauri's native label.
export function createFixtureDiagnostics(label: string, invoke: Invoke, bootId: string) {
  let currentStage = 'module-entry';
  const report = (value: Record<string, unknown> | null) => {
    if (value === null) {
      if (label !== 'main') return Promise.reject(Error('fixture-poll-main-only'));
      return invoke('workspace_fixture_report', {report: null});
    }
    const payload = {...value, stage: currentStage, bootId};
    return label === 'main'
      ? invoke('workspace_fixture_report', {report: payload})
      : invoke('workspace_window_command', {request: {op: 'fixtureReport', report: payload}});
  };
  const stage = (name: string, details: Record<string, unknown> = {}) => {
    currentStage = name;
    return report(details);
  };
  return {report, stage};
}
