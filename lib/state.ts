import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const stateDir = () => process.env.STATE_DIR ?? 'state';
const pathFor = (name: string, directory: string) => join(directory, `${name}.json`);

export function load<T>(name: string, fallback: T, directory = stateDir()): T {
  try {
    return JSON.parse(readFileSync(pathFor(name, directory), 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

export function save(name: string, data: unknown, directory = stateDir()): void {
  const path = pathFor(name, directory);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(data, null, 2));
  renameSync(temporaryPath, path);
}
