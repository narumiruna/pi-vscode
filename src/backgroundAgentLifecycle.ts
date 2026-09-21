export async function launchBackgroundExecution(
  initialize: () => Promise<void>,
  acceptPrompt: () => Promise<void>,
): Promise<void> {
  await initialize();
  await acceptPrompt();
}

export function isBackgroundTaskActive(status: string | undefined): boolean {
  return status === "starting" || status === "running";
}

export function countOccupiedBackgroundTaskSlots(
  taskStatuses: Iterable<readonly [string, string]>,
  activeTaskIds: Iterable<string>,
): number {
  const occupied = new Set(activeTaskIds);
  for (const [id, status] of taskStatuses) {
    if (isBackgroundTaskActive(status)) {
      occupied.add(id);
    }
  }
  return occupied.size;
}

export function assertBackgroundTaskCapacity(occupiedTaskCount: number, maximumTaskCount: number): void {
  if (occupiedTaskCount >= maximumTaskCount) {
    throw new Error(`At most ${maximumTaskCount} background agents can run at once.`);
  }
}

export function backgroundTaskIdsToEvict(
  taskIds: Iterable<string>,
  protectedTaskIds: { has(id: string): boolean },
  maximumTaskCount: number,
): string[] {
  const retained = [...taskIds];
  const evicted: string[] = [];
  while (retained.length > maximumTaskCount) {
    const index = retained.findIndex((id) => !protectedTaskIds.has(id));
    if (index < 0) {
      break;
    }
    evicted.push(...retained.splice(index, 1));
  }
  return evicted;
}
