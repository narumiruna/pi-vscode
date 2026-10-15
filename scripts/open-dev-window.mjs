import { execSync } from "node:child_process";

execSync("code --new-window .", {
  cwd: process.env.INIT_CWD || process.cwd(),
  stdio: "inherit",
});
