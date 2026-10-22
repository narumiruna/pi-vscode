// Test-only guard. Production launches do not load this file.
const fs = require("node:fs");
const path = require("node:path");
function blocked() {
  fs.appendFileSync(path.join(process.env.TEMP, "network-attempts.log"), "blocked network attempt\n");
  throw new Error("Network is forbidden in the extracted runtime smoke");
}
for (const name of ["node:http", "node:https"]) {
  const module = require(name);
  module.request = blocked;
  module.get = blocked;
}
require("node:net").Socket.prototype.connect = blocked;
require("node:dgram").Socket.prototype.send = blocked;
for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) require("node:dns")[name] = blocked;
globalThis.fetch = blocked;
require("node:module").syncBuiltinESMExports();
