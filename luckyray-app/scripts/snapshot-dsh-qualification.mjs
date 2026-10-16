// Engineering fixture extraction from explicit historical Git objects, not a
// checkout/main-dev mutation. Never embedded in the runtime adapter.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const [ref, outputArg] = process.argv.slice(2);
if (!/^[a-f0-9]{7,40}$/u.test(ref ?? "") || !outputArg) throw new Error("explicit-commit-and-new-root-required");
const root = resolve(outputArg);
await mkdir(root); await mkdir(join(root, "dsh-host")); await mkdir(join(root, "dsh-host/records"));
for (const file of ["runtime-authority.json", "package.json", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml", "records/dependency-audit.json"]) {
  const bytes = execFileSync("git", ["show", `${ref}:luckyray-app/dsh-host/${file}`], { maxBuffer: 4 * 1024 * 1024 });
  await writeFile(join(root, "dsh-host", file), bytes, { flag: "wx" });
}
process.stdout.write("FROZEN_GIT_DATA_SNAPSHOTTED\n");
