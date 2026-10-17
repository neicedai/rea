import { createHash } from "node:crypto";

import {
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  type JSONRPCResultResponse,
} from "@modelcontextprotocol/server";

import { err, ok, type Result } from "../domain/result.js";

type CatalogPageError =
  | { readonly kind: "invalid_cursor"; readonly message: string }
  | {
      readonly kind: "message_capacity";
      readonly message: string;
      readonly maximum_bytes: number;
      readonly required_bytes: number;
    };

/** Page SDK-converted definitions without changing their schemas or ordering. */
export const paginateToolsList = (
  message: JSONRPCResultResponse,
  cursor: unknown,
  maximumBytes = STDIO_DEFAULT_MAX_BUFFER_SIZE,
): Result<JSONRPCResultResponse, CatalogPageError> => {
  const tools = message.result["tools"];
  if (!Array.isArray(tools)) return ok(message);
  // Hash the exact array representation incrementally instead of allocating a
  // second complete catalog. The cursor cannot splice different catalogs.
  const hash = createHash("sha256").update("[");
  const sizes = tools.map((tool, index) => {
    const encoded = JSON.stringify(tool);
    if (index !== 0) hash.update(",");
    hash.update(encoded);
    return Buffer.byteLength(encoded, "utf8");
  });
  const digest = hash.update("]").digest("hex");
  let start = 0;
  if (cursor !== undefined) {
    const parsed =
      typeof cursor === "string"
        ? /^rea-tools-v1:([a-f0-9]{64}):([1-9][0-9]*)$/u.exec(cursor)
        : null;
    const offset = Number(parsed?.[2]);
    if (
      parsed?.[1] !== digest ||
      !Number.isSafeInteger(offset) ||
      offset >= tools.length
    )
      return err({
        kind: "invalid_cursor",
        message:
          "The tools/list cursor is invalid or belongs to a changed catalog. Restart tools/list without a cursor.",
      });
    start = offset;
  }
  const nextCursor = (offset: number): string =>
    `rea-tools-v1:${digest}:${offset}`;
  const {
    tools: _tools,
    nextCursor: _nextCursor,
    ...metadata
  } = message.result;
  const envelope = (end: number, pageTools: typeof tools) => ({
    ...message,
    result: {
      ...metadata,
      tools: pageTools,
      ...(end < tools.length ? { nextCursor: nextCursor(end) } : {}),
    },
  });
  const remainingBytes =
    Buffer.byteLength(JSON.stringify(envelope(tools.length, [])), "utf8") +
    sizes.slice(start).reduce((sum, size) => sum + size, 0) +
    Math.max(0, tools.length - start - 1) +
    1;
  if (remainingBytes <= maximumBytes)
    return ok(
      start === 0 ? message : envelope(tools.length, tools.slice(start)),
    );
  if (start === tools.length)
    return err({
      kind: "message_capacity",
      message: "The MCP catalog envelope exceeds the frame budget.",
      maximum_bytes: maximumBytes,
      required_bytes: remainingBytes,
    });
  let toolBytes = 0;
  let end = start;
  while (end < tools.length) {
    const candidateBytes = toolBytes + (sizes[end] ?? 0);
    // Include the complete JSON-RPC envelope, UTF-8 expansion, separators and
    // stdio newline. Each individual tool is indivisible on this boundary.
    const frameBytes =
      Buffer.byteLength(JSON.stringify(envelope(end + 1, [])), "utf8") +
      candidateBytes +
      (end - start) +
      1;
    if (frameBytes > maximumBytes) {
      if (end === start)
        return err({
          kind: "message_capacity",
          message:
            "An individual tool definition exceeds the MCP catalog frame budget.",
          maximum_bytes: maximumBytes,
          required_bytes: frameBytes,
        });
      break;
    }
    toolBytes = candidateBytes;
    end += 1;
  }
  return ok(
    start === 0 && end === tools.length
      ? message
      : envelope(end, tools.slice(start, end)),
  );
};
