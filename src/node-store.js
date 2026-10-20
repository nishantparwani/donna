// JSON-file backend for running on a laptop (and for tests/eval).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useBackend, hydrate } from './store.js';

export const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

export async function useFsStore(dir = process.env.AGENT_DATA_DIR || DEFAULT_DIR) {
  useBackend({
    immediate: true,
    async readAll() {
      const out = {};
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (f.endsWith('.json')) out[f.slice(0, -5)] = fs.readFileSync(path.join(dir, f), 'utf8');
      }
      return out;
    },
    writeSync(name, text) {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, name + '.json');
      fs.writeFileSync(f + '.tmp', text);
      fs.renameSync(f + '.tmp', f);
    },
    async write(name, text) { this.writeSync(name, text); },
    async readOne(name) {
      const f = path.join(dir, name + '.json');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined;
    },
  });
  await hydrate();
  return dir;
}
