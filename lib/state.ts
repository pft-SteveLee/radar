import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const pathFor = (name: string) => join(process.env.STATE_DIR ?? 'state', `${name}.json`);

export function load<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(pathFor(name), 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

export function save(name: string, data: unknown): void {
  const path = pathFor(name);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(data, null, 2));
  renameSync(temporaryPath, path);
}
