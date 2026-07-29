import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(scriptDir, "..", "runtime");
const executableName = process.platform === "win32" ? "node.exe" : "node";
const runtimeExecutable = join(runtimeDir, executableName);

await mkdir(runtimeDir, { recursive: true });
await copyFile(process.execPath, runtimeExecutable);
if (process.platform !== "win32") {
  await chmod(runtimeExecutable, 0o755);
}
await writeFile(
  join(runtimeDir, "runtime.json"),
  `${JSON.stringify(
    {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`Prepared bundled Node runtime ${process.version}: ${runtimeExecutable}`);
