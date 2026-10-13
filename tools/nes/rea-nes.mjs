#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectNesBytes } from './analyze.mjs';

export async function runNesCli(argv) {
  if (!argv.length || argv.includes('--help')) {
    process.stdout.write('Usage: rea nes-analyze ROM.nes [--output result.json] [--max-instructions N]\n');
    return argv.includes('--help') ? 0 : 2;
  }
  try {
    const path = resolve(argv[0]);
    const opts = {};
    let out = null;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--output' && argv[i + 1]) out = resolve(argv[++i]);
      else if (argv[i] === '--max-instructions' && argv[i + 1]) {
        const n = Number(argv[++i]);
        if (!Number.isSafeInteger(n) || n < 1 || n > 1000000) throw new Error('invalid instruction budget');
        opts.maxInstructions = n;
      } else throw new Error(`unknown option ${argv[i]}`);
    }
    const before = await stat(path);
    if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error('not a regular ROM file within 64 MiB');
    const data = await readFile(path);
    const after = await stat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error('source changed during inspection');
    const result = inspectNesBytes(data, opts);
    const output = JSON.stringify({ source_path: path, ...result }, null, 2) + '\n';
    if (out) { await writeFile(out, output, { flag: 'wx' }); process.stdout.write(out + '\n'); }
    else process.stdout.write(output);
    return 0;
  } catch (error) {
    process.stderr.write(`REA NES: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runNesCli(process.argv.slice(2));
}
