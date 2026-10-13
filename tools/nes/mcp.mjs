#!/usr/bin/env node
/** Small standalone stdio MCP endpoint, shipped alongside REA's normal server.
 *  This is intentionally a separate namespace until REA's canonical Evidence
 *  contracts acquire a NES subject/mapper analysis profile.
 */
import readline from 'node:readline';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { inspectNesBytes } from './analyze.mjs';

const TOOL_NAME = 'inspect_nes_rom';
const inputSchema = {
  type: 'object', additionalProperties: false, required: ['path'],
  properties: {
    path: { type: 'string', description: 'Absolute path to one local .nes ROM' },
    max_instructions: { type: 'integer', minimum: 1, maximum: 20000, default: 10000 },
  },
};
const tool = { name: TOOL_NAME, description: 'Read-only static analysis of iNES/NES2 ROM bytes, PRG/CHR 8 KiB/1 KiB banks, known fixed CPU windows and NMOS 6502 vector-reachable flow. Ambiguous switched banks and game semantics are not inferred.', inputSchema };

function emit(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
}
function error(id, code, message) { emit(id, { error: { code, message } }); }
async function inspect(args) {
  if (!args || typeof args.path !== 'string' || !isAbsolute(args.path)) throw new Error('path must be an absolute filesystem path');
  const maxInstructions = args.max_instructions ?? 10000;
  if (!Number.isSafeInteger(maxInstructions) || maxInstructions < 1 || maxInstructions > 20000) throw new Error('max_instructions must be 1..20000');
  if (Object.keys(args).some(key => !['path', 'max_instructions'].includes(key))) throw new Error('unexpected argument');
  const before = await stat(args.path);
  if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error('ROM must be a regular file of at most 64 MiB');
  const raw = await readFile(args.path);
  const after = await stat(args.path);
  if (before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.size !== after.size) throw new Error('ROM changed during read');
  return { source_path: args.path, ...inspectNesBytes(raw, { maxInstructions }) };
}
async function receive(line) {
  let req;
  try { req = JSON.parse(line); }
  catch { return; }
  if (req?.jsonrpc !== '2.0' || !Object.hasOwn(req, 'id')) return; // notifications or invalid
  const { id } = req;
  if (req.method === 'initialize') {
    const version = typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '2025-06-18';
    emit(id, { result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'rea-nes', version: '0.1.0' } } });
  } else if (req.method === 'tools/list') emit(id, { result: { tools: [tool] } });
  else if (req.method === 'ping') emit(id, { result: {} });
  else if (req.method === 'tools/call') {
    if (req.params?.name !== TOOL_NAME) return error(id, -32602, 'Unknown tool');
    try {
      const report = await inspect(req.params.arguments);
      const json = JSON.stringify(report);
      if (Buffer.byteLength(json, 'utf8') > 3 * 1024 * 1024) throw new Error('Analysis exceeds 3 MiB MCP text budget: reduce max_instructions or use CLI --output');
      emit(id, { result: { content: [{ type: 'text', text: json }] } });
    } catch (err) {
      emit(id, { result: { content: [{ type: 'text', text: String(err instanceof Error ? err.message : err) }], isError: true } });
    }
  } else error(id, -32601, 'Method not found');
}
if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])) {
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Serialized for deterministic tool results and bounded memory use.
  for await (const line of reader) await receive(line);
}
