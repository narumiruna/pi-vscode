export async function launchBackgroundExecution(
  initialize: () => Promise<void>,
  execute: () => Promise<void>,
  onExecutionFailure: (error: unknown) => void,
): Promise<void> {
  await initialize();
  void execute().then(undefined, onExecutionFailure);
}
