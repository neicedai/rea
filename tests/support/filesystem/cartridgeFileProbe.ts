import type { FileHandle } from "node:fs/promises";
import type { CartridgeFileSystem } from "../../../src/native/cartridgeFile.js";

/** Real descriptor observations with explicit close failures and post-read signals. */
export function createCartridgeFileProbe(
  fileSystem: CartridgeFileSystem,
  faults: {
    readonly close?: {
      readonly failures: number;
      readonly cause: () => Error;
    };
    readonly afterRead?: (buffer: Buffer) => void;
  },
) {
  const descriptors: FileHandle[] = [];
  let closeAttempts = 0;
  const observed: CartridgeFileSystem = {
    ...fileSystem,
    open: async (...args) => {
      const descriptor = await fileSystem.open(...args);
      descriptors.push(descriptor);
      return new Proxy(descriptor, {
        get(target, key) {
          const close = faults.close;
          const afterRead = faults.afterRead;
          if (key === "close" && close !== undefined)
            return async () => {
              if (++closeAttempts <= close.failures) throw close.cause();
              await target.close();
            };
          if (key === "read" && afterRead !== undefined)
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              const result = await target.read(
                buffer,
                offset,
                length,
                position,
              );
              afterRead(buffer);
              return result;
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  return {
    fileSystem: observed,
    get descriptor() {
      return descriptors.at(-1);
    },
    get descriptors(): readonly FileHandle[] {
      return [...descriptors];
    },
    get closeAttempts() {
      return closeAttempts;
    },
  };
}
