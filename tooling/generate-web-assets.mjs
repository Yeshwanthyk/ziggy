#!/usr/bin/env bun
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Generator assertion failures terminate this tooling boundary. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Generator assertion failures terminate this tooling boundary. */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..");

const sourceRoot = path.join(repositoryRoot, "clients", "web", "dist");

const destinationRoot = path.join(repositoryRoot, "src", "generated", "web-assets");

const check = process.argv.includes("--check");

const files = [
  "index.embed",
  "ziggy-prism.webp",
  "assets/app.js",
  "assets/index.css",
  "assets/prism-hero-wide-1440.webp",
  "assets/prism-hero-wide-768.webp",
  "assets/prism-tile-square-320.webp",
];

for (const relative of files) {
  const source = path.join(sourceRoot, relative);
  const destination = path.join(destinationRoot, relative);

  if (!existsSync(source)) throw new Error(`missing built web asset: ${source}`);

  if (check) {
    if (!existsSync(destination) || !readFileSync(source).equals(readFileSync(destination)))
      throw new Error(`generated web asset is stale: ${relative}`);
  } else {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

console.log(check ? "web assets current" : "web assets generated");
