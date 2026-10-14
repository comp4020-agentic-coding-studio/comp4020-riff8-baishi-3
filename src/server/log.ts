// One structured line per meaningful event, to stdout, where `flyctl logs`
// reads it. Characters appear as Name#abc: their name plus the first three hex
// digits of a hash of their id. The cookie itself is never logged.

import { createHash } from "node:crypto";

export const shortHash = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 3);

export const who = (c: { name: string; id: string }): string => `${c.name}#${shortHash(c.id)}`;

// The last few hundred lines, kept so the spec can assert what was logged
// (through the test-only route; see src/pages/api/test.ts).
export const recent: string[] = [];

export function log(category: string, message: string): void {
  const line = `${`[${category}]`.padEnd(10)}${message}`;
  console.log(line);
  recent.push(line);
  if (recent.length > 500) recent.shift();
}
