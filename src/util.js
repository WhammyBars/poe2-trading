import { pathToFileURL } from "node:url";

// Robust "is this the entry script" check (handles Windows path/casing quirks
// that a raw `import.meta.url === file://${process.argv[1]}` comparison trips on).
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}
