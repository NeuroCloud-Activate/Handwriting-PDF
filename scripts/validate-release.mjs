#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const errors = [];
const manifest = readJson("manifest.json");
const pkg = readJson("package.json");
const versions = readJson("versions.json");

const requiredFiles = [
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "PDF-LIB-LICENSE.md",
  "manifest.json",
  "versions.json",
  "main.js",
  "styles.css",
  "package.json",
  "scripts/build-release.mjs",
  "scripts/validate-release.mjs",
  ".github/workflows/checks.yml",
  ".github/workflows/release.yml"
];
for (const file of requiredFiles) {
  if (!existsSync(file)) errors.push(`Missing required root file: ${file}`);
}

for (const field of ["id", "name", "version", "minAppVersion", "description", "author", "isDesktopOnly"]) {
  if (manifest[field] === undefined || manifest[field] === "") errors.push(`manifest.json missing required field: ${field}`);
}

if (!/^[a-z]+(?:-[a-z]+)*$/.test(manifest.id || "")) {
  errors.push("manifest.id must use lowercase letters and hyphens only.");
}

if ((manifest.id || "").includes("obsidian") || (manifest.id || "").endsWith("plugin")) {
  errors.push("manifest.id must not contain 'obsidian' or end with 'plugin'.");
}

if (!/^\d+\.\d+\.\d+$/.test(manifest.version || "")) {
  errors.push("manifest.version must be semantic version x.y.z.");
}

if (pkg.version !== manifest.version) {
  errors.push(`package.json version (${pkg.version}) must match manifest.json version (${manifest.version}).`);
}

if (versions[manifest.version] !== manifest.minAppVersion) {
  errors.push(`versions.json must contain "${manifest.version}": "${manifest.minAppVersion}".`);
}

const main = readFileSync("main.js", "utf8");
if (!main.includes("function getPdfLib()") || !main.includes('require("./pdf-lib.min.js")')) {
  errors.push("main.js must keep the guarded pdf-lib loader for local development and release bundling.");
}

if (!readFileSync("README.md", "utf8").includes(manifest.version)) {
  errors.push("README.md must mention the current manifest version.");
}

if (errors.length) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Release validation passed for ${manifest.id} ${manifest.version}.`);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
