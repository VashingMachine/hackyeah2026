import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Read standard dotenv syntax without logging credentials or changing the process environment. */
export function readDotenv(path: string): Record<string, string> {
  return existsSync(path) ? Object.fromEntries(Object.entries(parseEnv(readFileSync(path, 'utf8'))).filter((entry): entry is [string, string] => entry[1] !== undefined)) : {};
}

/** Earlier files win; an explicitly supplied environment always wins over files. */
export function loadEnv(paths: string[], env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const path of paths) {
    for (const [key, value] of Object.entries(readDotenv(path))) {
      if (result[key] === undefined) result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  return result;
}
