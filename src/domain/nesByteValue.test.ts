import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { nesKnownBitsSchema, nesTwoBitValueSchema } from "./nesByteValue.js";

it.each(["draft-07", "draft-2020-12"] as const)(
  "preserves every byte/mask pair under advertised %s validation",
  (target) => {
    const ajv =
      target === "draft-07"
        ? new Ajv({ strict: false })
        : new Ajv2020({ strict: false });
    const schema = z.toJSONSchema(nesKnownBitsSchema, { target });
    expect(ajv.validateSchema(schema)).toBe(true);
    const validate = ajv.compile(schema);
    for (let mask = 0; mask <= 255; mask += 1)
      for (let value = 0; value <= 255; value += 1) {
        const valid = mask >= 1 && mask <= 254 && (value & ~mask) === 0;
        if (validate({ mask, value }) !== valid)
          throw new Error(
            `Incorrect bit proof for mask=${mask}, value=${value}`,
          );
      }
    for (const value of [
      null,
      {},
      { mask: 1 },
      { value: 1 },
      { mask: 1, value: -1 },
      { mask: 1, value: 256 },
      { mask: 1.5, value: 1 },
      { mask: 2, value: 0.5 },
      { mask: "1", value: 1 },
      { mask: 1, value: 1, extra: true },
    ])
      expect(validate(value)).toBe(nesKnownBitsSchema.safeParse(value).success);
    const twoBits = ajv.compile(
      z.toJSONSchema(nesTwoBitValueSchema, { target }),
    );
    for (let mask = 0; mask <= 3; mask += 1)
      for (let value = 0; value <= 3; value += 1)
        expect(twoBits({ mask, value })).toBe(
          nesTwoBitValueSchema.safeParse({ mask, value }).success,
        );
  },
);
