import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const output = "out/rich-content";
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["src/markdown.ts"],
  outfile: "out/markdown.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "linked",
});
await build({
  entryPoints: ["src/webview/richContent.mts"],
  outfile: `${output}/rich-content.js`,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome138",
  minify: true,
  legalComments: "linked",
});
await cp("node_modules/katex/dist/fonts", `${output}/fonts`, { recursive: true });
const mathCss = await readFile("node_modules/katex/dist/katex.min.css", "utf8");
const themeCss = await readFile("resources/rich-content.css", "utf8");
await writeFile(`${output}/rich-content.css`, `${mathCss}\n${themeCss}`);
// Preserve the full license texts for bundled packages, including transitive dependencies.
const licenses = [];
const visited = new Set();
async function collect(directory) {
  if (visited.has(directory)) return;
  visited.add(directory);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  } catch {
    return;
  }
  for (const name of ["LICENSE", "LICENSE.txt", "LICENSE.md", "license", "license.txt"]) {
    try {
      licenses.push(`${manifest.name}@${manifest.version}\n${await readFile(path.join(directory, name), "utf8")}`);
      break;
    } catch {
      /* Try the next conventional name. */
    }
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    let parent = directory;
    for (;;) {
      const location = path.join(parent, "node_modules", dependency);
      try {
        await readFile(path.join(location, "package.json"));
        await collect(location);
        break;
      } catch {
        /* Resolve a hoisted dependency. */
      }
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
}
for (const name of ["marked", "katex", "mermaid", "dompurify", "highlight.js"])
  await collect(path.resolve("node_modules", name));
await writeFile(`${output}/THIRD-PARTY-LICENSES.txt`, licenses.join("\n\n---\n\n"));
