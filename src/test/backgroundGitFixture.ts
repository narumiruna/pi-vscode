import { mkdir } from "node:fs/promises";
import { type GitIdentity, git } from "../gitSnapshots";

export async function seedTaskRepository(task: string, origin: GitIdentity, commit: string): Promise<void> {
  await mkdir(task, { recursive: true });
  await git(task, ["init", "-q"]);
  await git(task, ["fetch", "--no-tags", origin.root, commit]);
  await git(task, ["checkout", "--detach", commit]);
}

export function simulateSharedGitDirectory(task: string, origin: GitIdentity) {
  const snapshots = require("../gitSnapshots") as typeof import("../gitSnapshots");
  const { gitIdentity } = snapshots;
  // Use two real Git repositories with separate indexes. Simulate only their link to the same Git directory.
  return vi.spyOn(snapshots, "gitIdentity").mockImplementation(async (cwd, signal) => {
    const identity = await gitIdentity(cwd, signal);
    return identity.root === task ? { ...identity, commonDir: origin.commonDir } : identity;
  });
}
