// Stage the noVNC client the Remote Control viewer loads into public/novnc.
//
// The source is the @novnc/novnc package pinned exactly in package.json, which
// pnpm installs from the lockfile and verifies against its integrity hash. Only
// the browser library and its licences are copied; nothing here runs in the
// Worker. wrangler runs this before `wrangler dev` and `wrangler deploy`
// (`build.command` in wrangler.jsonc).

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinned = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies?.["@novnc/novnc"];
if (!pinned || !/^\d+\.\d+\.\d+$/.test(pinned)) {
  throw new Error("package.json must pin @novnc/novnc to one exact version");
}

const source = join(root, "node_modules", "@novnc", "novnc");
if (!existsSync(join(source, "package.json"))) {
  throw new Error("@novnc/novnc is not installed; run `pnpm install` in cloudflare-control first");
}
const installed = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
if (installed !== pinned) {
  throw new Error(`@novnc/novnc ${installed} is installed but package.json pins ${pinned}; run \`pnpm install\``);
}

const target = join(root, "public", "novnc");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const entry of ["core", "vendor", "AUTHORS", "LICENSE.txt", "docs/LICENSE.MPL-2.0", "docs/LICENSE.BSD-2-Clause", "docs/LICENSE.BSD-3-Clause", "docs/LICENSE.OFL-1.1"]) {
  const from = join(source, entry);
  if (!existsSync(from)) throw new Error(`@novnc/novnc ${installed} has no ${entry}`);
  cpSync(from, join(target, entry), { recursive: true });
}
console.log(`Staged noVNC ${installed} into public/novnc`);
