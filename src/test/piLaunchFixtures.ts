import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// npm cmd-shim's Node template, without shebang arguments or environment assignments.
export function npmNodeShim(target: string): string {
  return `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  " %TARGET% " %*\r\n`.replace(
    '" %TARGET% "',
    `"%dp0%\\${target}"`,
  );
}

export async function launchFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-launch-"));
  const bin = path.join(root, "bin space %TEMP% 漢字");
  await mkdir(bin);
  const script = path.join(bin, "fixture.cjs");
  const pidFile = path.join(root, "pid");
  const descendantFile = path.join(root, "descendant");
  await writeFile(script, fixtureScript);
  const shim = path.join(bin, "pi.cmd");
  await writeFile(shim, npmNodeShim("fixture.cjs"));
  if (process.platform === "win32") await copyFile(process.execPath, path.join(bin, "node.exe"));
  const executable = process.platform === "win32" ? shim : path.join(bin, "pi");
  if (process.platform !== "win32") {
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
    await chmod(executable, 0o755);
  }
  return {
    root,
    bin,
    script,
    shim,
    executable,
    pidFile,
    descendantFile,
    env: { PI_FIXTURE_PID: pidFile, PI_FIXTURE_DESCENDANT: descendantFile },
    async cleanup() {
      for (const filename of [pidFile, descendantFile]) {
        try {
          const pid = Number(await readFile(filename, "utf8"));
          if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
        } catch {
          /* The fixture already exited. */
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 4_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Fixture observation deadline reached.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function fixturePid(filename: string): Promise<number> {
  let pid = 0;
  await waitUntil(async () => {
    try {
      pid = Number(await readFile(filename, "utf8"));
      return pid > 0;
    } catch {
      return false;
    }
  });
  return pid;
}

// Keep descendants alive independently of stdin EOF so shell-only cleanup cannot pass.
const fixtureScript = `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.PI_FIXTURE_PID) fs.writeFileSync(process.env.PI_FIXTURE_PID, String(process.pid));
if (args.includes('descendant')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: ['ignore', 1, 2]});
  fs.writeFileSync(process.env.PI_FIXTURE_DESCENDANT, String(child.pid));
}
if (args.includes('early-exit')) setTimeout(() => process.exit(7), 100);
if (args.includes('overflow')) { process.stdout.write('x'.repeat(6 * 1024 * 1024)); setInterval(()=>{},1000); }
else if (args.includes('stdin-failure')) { process.exit(0); }
else if (args.includes('--mode')) {
  require('node:readline').createInterface({input: process.stdin}).on('line', line => {
    const q = JSON.parse(line);
    if (args.includes('timeout') || q.message === 'wait-for-exit') return;
    if (q.type === 'prompt' && q.message === 'oversized') { process.stdout.write('x'.repeat(6 * 1024 * 1024)); return; }
    if (q.type === 'prompt' && q.message === 'bad-queue') { console.log(JSON.stringify({type:'queue_update',steering:null})); return; }
    console.log(JSON.stringify({type:'response',id:q.id,command:q.type,success:true,data:{pid:process.pid,args,script:__filename}}));
  });
  setInterval(()=>{},1000);
} else if (args.includes('hang')) { process.stdin.resume(); setInterval(()=>{},1000); }
else { let input=''; process.stdin.on('data', x => input+=x); process.stdin.on('end', () => console.log(JSON.stringify({args,input}))); }
`;
