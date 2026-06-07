#!/usr/bin/env node

import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";

const distDir = "dist";
const banner = [
  "/*",
  " * Bundled pdf-lib is included under the MIT license.",
  " * See PDF-LIB-LICENSE.md in the repository root.",
  " */",
  ""
].join("\n");

await mkdir(distDir, { recursive: true });

const pdfLib = (await readFile("pdf-lib.min.js", "utf8")).replace(/\n\/\/# sourceMappingURL=pdf-lib\.min\.js\.map\s*$/, "");
const main = await readFile("main.js", "utf8");
await writeFile(join(distDir, "main.js"), `${banner}${pdfLib}\n\n${main}`);

await copyFile("manifest.json", join(distDir, "manifest.json"));
await copyFile("styles.css", join(distDir, "styles.css"));

console.log("Built release assets in dist/: main.js, manifest.json, styles.css");
