/**
 * dsh-armor — host patch engine.
 *
 * Applies a declarative patch list to DeepSeek Harness host modules
 * (`resources/app/dsh/node_modules/@deepseek-ai/...`).
 *
 * Design rules:
 *  - idempotent: a patch is skipped when its marker is already present
 *  - reversible: first write of a file drops `<file>.armor.bak`
 *  - honest: a patch that no longer matches is reported as DRIFT, never faked
 *
 * CLI (scripts/apply.mjs):
 *   --check    report state only (no writes)
 *   --apply    apply everything that still matches
 *   --revert   restore every `.armor.bak`
 *   --host=<dir>  override host root (default: auto-detect desktop install)
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

export const HOST_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || "", "Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai"),
  path.join(os.homedir(), "AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai"),
  "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai",
  "/usr/lib/deepseek-harness/resources/app/dsh/node_modules/@deepseek-ai",
];

export function detectHost(explicit) {
  if (explicit) return explicit;
  for (const c of HOST_CANDIDATES) if (c && fs.existsSync(c)) return c;
  return null;
}

export function loadPatches(patchesFile) {
  const file = patchesFile || path.join(REPO_ROOT, "patches", "host.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function backupPath(file) {
  return file + ".armor.bak";
}

/** @returns {{id:string,state:string,detail?:string}} */
export function runPatch(host, patch, { dryRun = false } = {}) {
  const file = path.join(host, patch.file);
  if (!fs.existsSync(file)) return { id: patch.id, state: "SKIP", detail: "file not found" };
  const src = fs.readFileSync(file, "utf8");

  if (src.includes(patch.marker)) return { id: patch.id, state: "APPLIED" };
  if (!src.includes(patch.find)) return { id: patch.id, state: "DRIFT", detail: "anchor not found" };
  if (dryRun) return { id: patch.id, state: "PENDING" };

  const bak = backupPath(file);
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  fs.writeFileSync(file, src.replace(patch.find, patch.replace), "utf8");
  return { id: patch.id, state: "APPLIED", detail: "patched now" };
}

export function applyAll({ host, patchesFile, dryRun = false } = {}) {
  const root = detectHost(host);
  if (!root) throw new Error("host not found — pass --host=<dir>");
  const patches = loadPatches(patchesFile);
  return { host: root, results: patches.map((p) => runPatch(root, p, { dryRun })) };
}

export function revertAll({ host, patchesFile } = {}) {
  const root = detectHost(host);
  if (!root) throw new Error("host not found — pass --host=<dir>");
  const patches = loadPatches(patchesFile);
  const seen = new Set();
  const results = [];
  for (const p of patches) {
    const file = path.join(root, p.file);
    if (seen.has(file)) continue;
    seen.add(file);
    const bak = backupPath(file);
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, file);
      fs.rmSync(bak);
      results.push({ id: p.id, state: "REVERTED" });
    } else {
      results.push({ id: p.id, state: "SKIP", detail: "no backup" });
    }
  }
  return { host: root, results };
}

/** cordis plugin entry: apply on activate unless disabled. */
export const name = "dsh-armor";

export function apply(ctx, config = {}) {
  if (config.applyOnStart === false) return;
  try {
    const { host, results } = applyAll({ host: config.host, patchesFile: config.patchesFile });
    const drift = results.filter((r) => r.state === "DRIFT");
    ctx?.logger?.info?.(`[dsh-armor] ${results.length - drift.length}/${results.length} applied in ${host}`);
    for (const d of drift) ctx?.logger?.warn?.(`[dsh-armor] drift: ${d.id}`);
  } catch (e) {
    ctx?.logger?.warn?.(`[dsh-armor] ${e.message}`);
  }
}

export default { name, apply };
