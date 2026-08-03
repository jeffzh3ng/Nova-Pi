import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(scriptDir, "..", "dist");

if (basename(distDir) !== "dist" || basename(dirname(distDir)) !== "host") {
  throw new Error(`Refusing to clean unexpected host output directory: ${distDir}`);
}

await rm(distDir, { recursive: true, force: true });
