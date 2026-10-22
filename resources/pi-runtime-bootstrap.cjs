// Electron reads this flag before JavaScript starts. Do not pass it to Pi tools or nested Electron apps.
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.PI_PACKAGE_DIR;
delete process.env.PI_MANAGED_INSTALL_ROOT;
process.env.PI_SKIP_VERSION_CHECK = "1";

async function start() {
  const packageRoot = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent");
  const cli = path.join(packageRoot, "dist", "bundle", "cli.js");
  const metadata = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const version = process.versions.node.split(".").map(Number);
  if (
    process.argv[2] !== cli ||
    metadata.name !== "@earendil-works/pi-coding-agent" ||
    metadata.version !== "1.3.0" ||
    metadata.bin?.pi !== "dist/bundle/cli.js" ||
    version[0] < 22 ||
    (version[0] === 22 && version[1] < 19)
  )
    throw new Error("Invalid packaged runtime.");
  const args = process.argv.slice(3);
  // The extension owns this installation. Do not enter upstream's CLI updater, even with a custom npmCommand.
  if (args[0] === "update") {
    process.stderr.write(
      "Packaged Pi updates are provided by extension releases. Use an external Pi for CLI updates.\n",
    );
    process.exit(1);
  }
  process.argv = [process.execPath, cli, ...args];
  await import(pathToFileURL(cli).href);
}

void start().catch(() => {
  process.stderr.write(
    "Packaged Pi could not start. Reinstall the extension or select external Pi. No PATH fallback was attempted.\n",
  );
  process.exit(1);
});
