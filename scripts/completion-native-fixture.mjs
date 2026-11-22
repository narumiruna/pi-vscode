import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Called by the isolated native UI runner. Pi is its deterministic RPC fixture.
export async function assertNativeFileCompletion({ pi, page, invoke, pick, until, directory, workspace }) {
  const log = () => readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => "");
  const before = await log();
  await writeFile(path.join(workspace, "completion-capture.txt"), "completion disk snapshot\n");
  await writeFile(path.join(workspace, "completion-path with spaces.txt"), "must not attach path-only bytes\n");
  await writeFile(path.join(workspace, "completion-binary.bin"), Buffer.from([0, 1, 2]));
  for (const directory of ["node_modules", "out", "completion-excluded", "completion-other-excluded"]) {
    await mkdir(path.join(workspace, directory), { recursive: true });
    await writeFile(path.join(workspace, directory, "completion-capture-hidden.txt"), "must not appear in completion\n");
  }
  await invoke("completionExclusions");
  const input = pi.locator("#input");
  const menu = pi.locator("#file-completions");
  const search = async (text, expected) => {
    await input.fill(text);
    if (expected)
      await until(async () => await menu.isVisible() && await menu.innerText() === expected, `completion for ${text}`);
    else await menu.waitFor({ state: "visible" });
  };
  const corpus = "completion-large-fixture";
  const add = async relative => {
    const file = path.join(workspace, corpus, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "completion fixture\n");
  };
  try {
    await mkdir(path.join(workspace, corpus));
    const unrelated = Array.from({ length: 2_304 }, (_, index) => `completion-decoy-${index}.txt`);
    for (let offset = 0; offset < unrelated.length; offset += 64)
      await Promise.all(unrelated.slice(offset, offset + 64).map(add));
    await Promise.all([
      "preAbC/Xy,(part)!/deep/child.txt",
      "preAbC/XyZ(part)!/deep/decoy.txt",
      "preAbC/other/Xy,(part)!/decoy.txt",
      "ÉK𐐀İ/inside/child.txt",
      "ÉK𐐀İ-file.txt",
      "Zİmark.txt",
      "AΣ-example.txt",
      "Σ-example.txt",
      "escaped-[literal].txt",
    ].map(add));
    const native = (include, extra) => invoke("completionFileSearch", {
      include,
      exclude: "{**/.git/**,**/node_modules/**,**/out/**,**/completion-excluded/**,**/completion-other-excluded/**}",
      maxResults: 2_000,
      ...extra,
    });
    const baseline = await native("**/*");
    assert.equal(baseline.paths.length, 2_000);
    const returned = new Set(baseline.paths);
    const omitted = unrelated.find(name => !returned.has(`${corpus}/${name}`));
    assert.ok(omitted, "the old discovery cap must omit at least one known unique filename");
    const target = `${corpus}/${omitted}`;
    await search(`@${omitted}`, target);
    await search('@"abc/xy,(part)!/deep/"', `${corpus}/preAbC/Xy,(part)!/deep/child.txt`);
    await search('@"abc/xy,(part)!"', `${corpus}/preAbC/Xy,(part)!/deep/child.txt`);
    await search("@éK𐐨i̇-file", `${corpus}/ÉK𐐀İ-file.txt`);
    await search("@éK𐐨İ/", `${corpus}/ÉK𐐀İ/inside/child.txt`);
    await search("@̇mark", `${corpus}/Zİmark.txt`);
    await search("@ς-example", `${corpus}/AΣ-example.txt`);
    assert.deepEqual((await native("**/*[[]literal[]]*")).paths, [`${corpus}/escaped-[literal].txt`]);
    for (const extra of [{ cancel: true }, { cancelInFlight: true }])
      assert.deepEqual((await native("**/*", extra)).paths, []);

    // Timings are observations, not pass/fail gates. Compare the raw native API on the same corpus.
    const literal = omitted.replace(/[a-z]/g, letter => `[${letter.toUpperCase()}${letter}]`);
    const narrowed = `{**/*${literal}*,**/*${literal}*/**}`;
    const timings = { baseline: [], narrowed: [] };
    let baselineMisses = 0;
    for (let sample = 0; sample < 7; sample++) {
      const all = await native("**/*");
      const matching = await native(narrowed);
      assert.equal(all.paths.length, 2_000);
      assert.deepEqual(matching.paths, [target]);
      if (!all.paths.includes(target)) baselineMisses++;
      timings.baseline.push(all.elapsedMs);
      timings.narrowed.push(matching.elapsedMs);
    }
    const summarize = times => {
      const sorted = times.sort((left, right) => left - right);
      return { medianMs: sorted[3], p95Ms: sorted[6] };
    };
    console.log(`PI_NATIVE_COMPLETION_DISCOVERY ${JSON.stringify({
      unrelated: unrelated.length,
      returnedBefore: 2_000,
      returnedAfter: 1,
      baselineMisses,
      samples: 7,
      baseline: summarize(timings.baseline),
      narrowed: summarize(timings.narrowed),
    })}`);
  } finally {
    await input.fill("");
    await rm(path.join(workspace, corpus), { recursive: true, force: true });
  }
  await invoke("completionDirty");
  await search("Explain @completion-capture");
  assert.equal(
    await menu.innerText(),
    "completion-capture.txt",
    "native search must retain generated and configured exclusions",
  );
  await input.press("Enter");
  await until(async () => (await input.inputValue()) === "Explain ", "completion attachment token removed");
  assert.match(await pi.locator("#attachments").innerText(), /completion-capture/);
  await pi.locator("#add-context").click(); await pick("View attachments");
  await until(async () => (await invoke("completionInspection")).includes("completion dirty snapshot"), "completion snapshot inspection");
  await page.keyboard.press("Escape");

  await search("See ./completion-path");
  await input.press("Tab");
  await until(async () => (await input.inputValue()) === 'See "completion-path with spaces.txt"', "path-only insertion");
  assert.equal(await pi.locator("#attachments [data-remove-attachment]").count(), 1);
  await search("Keep @completion-binary"); await input.press("Enter");
  await until(async () => !(await input.evaluate(item => item.readOnly)), "failed capture released composer");
  assert.equal(await input.inputValue(), "Keep @completion-binary");
  assert.equal(await pi.locator("#attachments [data-remove-attachment]").count(), 1);

  await input.fill("@completion-capture"); await input.fill("A newer draft");
  await pi.waitForTimeout(300);
  assert.equal(await input.inputValue(), "A newer draft"); assert.equal(await menu.isVisible(), false);
  assert.equal(await log(), before, "completion, capture and inspection must not send a model request");
  await input.fill("Use the captured completion snapshot once"); await input.press("Enter");
  await until(async () => (await log()).length > before.length, "explicit completion Send recorded");
  await until(async () => !(await pi.locator("#cancel").isVisible()), "completion Send settled");
  const added = (await log()).slice(before.length).trim().split("\n").map(JSON.parse);
  assert.equal(added.length, 1);
  assert.equal(added[0].message.split("completion dirty snapshot").length - 1, 1);
  assert.doesNotMatch(added[0].message, /must not attach path-only bytes|completion disk snapshot/);
  await until(async () => (await pi.locator("#attachments [data-remove-attachment]").count()) === 0, "captured snapshot consumed once");
  console.log("PI_NATIVE_COMPLETION search, dirty capture, inspection, path-only Tab, failed capture, newer draft and explicit single Send passed");
}
