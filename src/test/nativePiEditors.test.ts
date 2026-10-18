import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import { captureNativeEditorGuard } from "../nativePiEditors";
import { MockUri } from "./vscodeMock";

function editor(file: string, dirty = false): vscode.TextDocument {
  return { uri: MockUri.file(file), version: 1, isDirty: dirty } as unknown as vscode.TextDocument;
}

async function withFiles(action: (root: string, target: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-native-editors-")));
  try {
    await action(root, path.join(root, ".pi/settings.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("native editor capture permits proved unrelated missing files and missing parents", async () => {
  await withFiles(async (root, target) => {
    const documents = [editor(path.join(root, "deleted.txt"), true), editor(path.join(root, "gone/nested/file.txt"))];
    const guard = await captureNativeEditorGuard(documents, [target]);
    await guard(documents);
    await guard([]);
    // A target can be created when no open editor refers to it.
    await mkdir(path.dirname(target));
    await writeFile(target, "{}");
    await guard(documents);
  });
});

test("native editor rechecks permit unrelated files and parents deleted after capture", async () => {
  await withFiles(async (root, target) => {
    const file = path.join(root, "unrelated/nested/file.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "unrelated");
    const document = editor(file, true);
    const guard = await captureNativeEditorGuard([document], [target]);
    await rm(path.join(root, "unrelated"), { recursive: true });
    await guard([document]);
    await guard([]); // The original-binding loop must also permit the deletion.
  });
});

test("native editor rechecks permit later-opened unrelated missing editors", async () => {
  await withFiles(async (root, target) => {
    const guard = await captureNativeEditorGuard([], [target]);
    await guard([editor(path.join(root, "deleted.txt"), true), editor(path.join(root, "gone/nested/file.txt"), true)]);
  });
});

test("native editor guard rejects open missing targets with existing or missing parents", async () => {
  await withFiles(async (root, target) => {
    for (const createParent of [false, true]) {
      if (createParent) await mkdir(path.dirname(target));
      const guard = await captureNativeEditorGuard([], [target]);
      for (const dirty of [false, true]) {
        const document = editor(target, dirty);
        await assert.rejects(captureNativeEditorGuard([document], [target]), /missing editor/);
        await assert.rejects(guard([document]), /missing editor/);
      }
    }
  });
});

test("missing target name variants fail closed on case-insensitive host platforms", async () => {
  await withFiles(async (root, target) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      for (const value of ["win32", "darwin"]) {
        Object.defineProperty(process, "platform", { ...platform, value });
        const guard = await captureNativeEditorGuard([], [target]);
        for (const name of ["SETTINGS.JSON", "ſettings.json"]) {
          const document = editor(path.join(root, ".pi", name), true);
          await assert.rejects(captureNativeEditorGuard([document], [target]), /missing editor/);
          await assert.rejects(guard([document]), /missing editor/);
        }
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

test("native editor guard rejects missing dirty targets through workspace and parent aliases", async () => {
  await withFiles(async (root, target) => {
    const workspaceAlias = path.join(root, "workspace-alias");
    await symlink(root, workspaceAlias, "junction");
    const agent = path.join(root, "agent");
    await mkdir(agent);
    const parentAlias = path.join(root, "parent-alias");
    await symlink(agent, parentAlias, "junction");
    const missingGlobal = path.join(agent, "missing/parents/mcp.json");
    const targets = [target, missingGlobal];
    const guard = await captureNativeEditorGuard([], targets);
    const aliases = [
      path.join(workspaceAlias, ".pi/settings.json"),
      path.join(parentAlias, "missing/parents/mcp.json"),
    ];
    for (const file of aliases) {
      const document = editor(file, true);
      await assert.rejects(captureNativeEditorGuard([document], targets), /missing editor/);
      await assert.rejects(guard([document]), /missing editor/);
    }
  });
});

test("native editor guard rejects target deletion even after its editor closes", async () => {
  await withFiles(async (_root, target) => {
    await mkdir(path.dirname(target));
    await writeFile(target, "{}");
    const document = editor(target);
    const guard = await captureNativeEditorGuard([document], [target]);
    await rm(target);
    await assert.rejects(guard([document]), /missing editor/);
    await assert.rejects(guard([]), /missing editor/);
  });
});

test("native editor guard preserves target dirty and version checks", async () => {
  await withFiles(async (_root, target) => {
    await mkdir(path.dirname(target));
    await writeFile(target, "{}");
    const document = editor(target);
    const guard = await captureNativeEditorGuard([document], [target]);
    await guard([document]);
    Object.assign(document, { version: 2 });
    await assert.rejects(guard([document]), /editor changed/);
    await assert.rejects(guard([]), /editor changed/);
    const dirty = editor(target, true);
    const dirtyGuard = await captureNativeEditorGuard([dirty], [target]);
    await assert.rejects(dirtyGuard([dirty]), /unsaved/);
    await assert.rejects(guard([editor(target, true)]), /editor changed/);
    const laterGuard = await captureNativeEditorGuard([], [target]);
    await assert.rejects(laterGuard([dirty]), /unsaved/);
  });
});

test("native editor guard preserves existing file and directory alias checks", async () => {
  await withFiles(async (root, target) => {
    await mkdir(path.dirname(target));
    await writeFile(target, "{}");
    const fileAlias = path.join(root, "settings-alias.json");
    await symlink(target, fileAlias, "file");
    const workspaceAlias = path.join(root, "workspace-alias");
    await symlink(root, workspaceAlias, "junction");
    for (const file of [fileAlias, path.join(workspaceAlias, ".pi/settings.json")]) {
      const dirty = editor(file, true);
      const guard = await captureNativeEditorGuard([dirty], [target]);
      await assert.rejects(guard([dirty]), /unsaved/);
      const clean = editor(file);
      const cleanGuard = await captureNativeEditorGuard([clean], [target]);
      Object.assign(clean, { version: 2 });
      await assert.rejects(cleanGuard([clean]), /editor changed/);
    }
    const clean = editor(fileAlias);
    const guard = await captureNativeEditorGuard([clean], [target]);
    const other = path.join(root, "other.json");
    await writeFile(other, "{}");
    await rm(fileAlias);
    await symlink(other, fileAlias, "file");
    await assert.rejects(guard([clean]), /retargeted/);
    await assert.rejects(guard([]), /retargeted/);
  });
});

test("native editor guard rejects retargeted parent aliases for missing unrelated files", async () => {
  await withFiles(async (root, target) => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await mkdir(first);
    await mkdir(second);
    const alias = path.join(root, "alias");
    await symlink(first, alias, "junction");
    const document = editor(path.join(alias, "missing/nested.txt"));
    const guard = await captureNativeEditorGuard([document], [target]);
    await guard([document]);
    await rm(alias);
    await symlink(second, alias, "junction");
    await assert.rejects(guard([document]), /retargeted/);
    await assert.rejects(guard([]), /retargeted/);
  });
});

test("native editor guard rejects dangling file and parent aliases instead of ignoring ENOENT", async () => {
  await withFiles(async (root, target) => {
    const fileAlias = path.join(root, "dangling-file");
    await symlink(target, fileAlias, "file");
    const parentAlias = path.join(root, "dangling-parent");
    await symlink(path.dirname(target), parentAlias, "junction");
    const guard = await captureNativeEditorGuard([], [target]);
    for (const file of [fileAlias, path.join(parentAlias, "settings.json"), path.join(parentAlias, "unrelated.txt")]) {
      const document = editor(file, true);
      await assert.rejects(captureNativeEditorGuard([document], [target]));
      await assert.rejects(guard([document]));
    }
    // A previously known alias must also fail if its destination disappears.
    await mkdir(path.dirname(target));
    await writeFile(target, "{}");
    const document = editor(fileAlias);
    const knownGuard = await captureNativeEditorGuard([document], [target]);
    await rm(target);
    await assert.rejects(knownGuard([]));
  });
});

test("native editor guard propagates non-ENOENT path failures", async () => {
  await withFiles(async (root, target) => {
    const regular = path.join(root, "regular-file");
    await writeFile(regular, "text");
    const invalid = editor(path.join(regular, "child.txt"));
    const guard = await captureNativeEditorGuard([], [target]);
    await assert.rejects(captureNativeEditorGuard([invalid], [target]));
    await assert.rejects(guard([invalid]));
    if (process.platform !== "win32") {
      const loop = path.join(root, "loop");
      await symlink(loop, loop);
      await assert.rejects(captureNativeEditorGuard([editor(loop)], [target]), { code: "ELOOP" });
      await assert.rejects(guard([editor(loop)]), { code: "ELOOP" });
    }
    // Root bypasses POSIX mode permissions; exercise EACCES only where enforced.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const denied = path.join(root, "denied");
      await mkdir(denied);
      await chmod(denied, 0);
      try {
        const document = editor(path.join(denied, "missing.txt"));
        await assert.rejects(captureNativeEditorGuard([document], [target]), { code: "EACCES" });
        await assert.rejects(guard([document]), { code: "EACCES" });
      } finally {
        await chmod(denied, 0o700);
      }
    }
  });
});

test("native editor guard retains the 1000 file-backed editor limit at capture and recheck", async () => {
  await withFiles(async (root, target) => {
    const documents = Array.from({ length: 1001 }, () => editor(path.join(root, "missing.txt")));
    await assert.rejects(captureNativeEditorGuard(documents, [target]), /Too many/);
    const guard = await captureNativeEditorGuard([], [target]);
    await assert.rejects(guard(documents), /Too many/);
    const untitled = {
      uri: new MockUri("untitled", "draft"),
      version: 1,
      isDirty: true,
    } as unknown as vscode.TextDocument;
    await guard([untitled]);
  });
});
