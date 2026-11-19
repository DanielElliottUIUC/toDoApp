// Reads and rewrites a .env file without ever printing a value.

import fs from "node:fs";

/** Parses KEY=value lines. Quotes around a value are removed. Comments and blank lines are ignored. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Returns the text with each entry set: an existing line for the key is
 * replaced in place, a missing key is appended. Every other line, including
 * comments and line endings, is left exactly as it was.
 */
export function setEnvEntries(text, entries) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(entries));
  for (const [key, value] of pending) {
    if (/[\r\n]/.test(value)) throw new Error(`the value for ${key} contains a line break`);
  }
  const next = lines.map((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m && pending.has(m[1])) {
      const value = pending.get(m[1]);
      pending.delete(m[1]);
      return `${m[1]}=${value}`;
    }
    return line;
  });
  if (pending.size) {
    while (next.length && next[next.length - 1] === "") next.pop();
    for (const [key, value] of pending) next.push(`${key}=${value}`);
    next.push("");
  }
  return next.join(eol);
}

export function readEnvFile(file) {
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
}

export function writeEnvEntries(file, entries) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.writeFileSync(file, setEnvEntries(before, entries));
}
