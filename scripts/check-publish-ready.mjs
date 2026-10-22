/**
 * Refuse to publish a package that is missing what a package needs, or whose
 * registry metadata disagrees with itself.
 *
 * `homepage` and `repository` are how package directories link back to a
 * project. `mcpName` in package.json must equal `name` in server.json, or the
 * MCP Registry rejects the server. Versions must agree, or the registry entry
 * points at a package version that does not exist. None of this is noticed
 * until a version is published and immutable, so it is checked here.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const problems = [];
const PLACEHOLDER = /OWNER|example\.com|CHANGE_?ME|TODO/i;

for (const field of ["homepage", "repository", "author", "bugs"]) {
  const value = pkg[field];
  if (!value) {
    problems.push(`package.json is missing "${field}"`);
    continue;
  }
  const asText = typeof value === "string" ? value : JSON.stringify(value);
  if (PLACEHOLDER.test(asText)) problems.push(`package.json "${field}" is still a placeholder: ${asText}`);
}

for (const f of ["LICENSE", "README.md", "dist/index.js", "dist/cli.js", "dist/selftest.js"])
  if (!existsSync(resolve(root, f))) problems.push(`${f} is missing; run the build first`);

// MCP Registry metadata.
const serverPath = resolve(root, "server.json");
if (!existsSync(serverPath)) {
  problems.push("server.json is missing");
} else {
  const server = JSON.parse(readFileSync(serverPath, "utf8"));
  if (!pkg.mcpName) problems.push('package.json is missing "mcpName"');
  else if (pkg.mcpName !== server.name)
    problems.push(`package.json mcpName "${pkg.mcpName}" differs from server.json name "${server.name}"`);
  if (server.version !== pkg.version)
    problems.push(`server.json version "${server.version}" differs from package.json version "${pkg.version}"`);
  const npmEntries = (server.packages ?? []).filter((p) => p.registryType === "npm");
  if (!npmEntries.length) problems.push("server.json has no npm package entry");
  for (const p of npmEntries) {
    if (p.identifier !== pkg.name)
      problems.push(`server.json package identifier "${p.identifier}" differs from package.json name "${pkg.name}"`);
    if (p.version !== pkg.version)
      problems.push(`server.json package version "${p.version}" differs from package.json version "${pkg.version}"`);
  }
  if (typeof server.description !== "string" || server.description.length > 100)
    problems.push("server.json description must be a string of at most 100 characters");
  if ((pkg.files ?? []).includes("server.json")) problems.push("server.json must not be in the npm files list");
}

// The README example must be the exact code the self-test runs through the rules.
if (existsSync(resolve(root, "dist/selftest.js")) && existsSync(resolve(root, "README.md"))) {
  const { README_EXAMPLE } = await import(pathToFileURL(resolve(root, "dist/selftest.js")).href);
  const readme = readFileSync(resolve(root, "README.md"), "utf8").replace(/\r\n/g, "\n");
  if (!readme.includes(README_EXAMPLE))
    problems.push("README.md no longer contains the tested example from src/selftest.ts (README_EXAMPLE)");
}

if (problems.length) {
  console.error("not ready to publish:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("publish checks passed");
