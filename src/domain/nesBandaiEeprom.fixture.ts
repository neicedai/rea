import type { NesMapperEvent } from "./nesMapperEvents.js";
import { bandaiCases, bandaiFixture } from "./nesBandai.fixture.js";

export const eepromCases = [
  { mapper: 159, model: "x24c01", page_size: 4, capacity: 128 },
  { mapper: 16, model: "x24c02", page_size: 4, capacity: 256 },
  { mapper: 16, model: "x24c02", page_size: 16, capacity: 256 },
] as const;

/** Hardware bus stimulus, independent of protocol implementation. */
export class EepromBusFixture {
  readonly events: NesMapperEvent[] = [];
  control(value: number) {
    this.events.push({
      kind: "cpu-write",
      address: 0x800d,
      value,
      preceded_by_cpu_write: false,
    });
  }
  read(address = 0x6000) {
    this.events.push({ kind: "cpu-read", address });
  }
  start() {
    this.control(0x40);
    this.control(0x60);
    this.control(0x20);
  }
  stop() {
    this.control(0);
    this.control(0x20);
    this.control(0x60);
  }
  send(value: number) {
    for (let bit = 7; bit >= 0; bit--) {
      const data = ((value >> bit) & 1) << 6;
      this.control(data);
      this.control(data | 32);
      this.control(data);
    }
    this.control(0x80);
    this.control(0xa0);
    this.read(0x7fff);
    this.control(0x80);
  }
  receive(ack: boolean) {
    for (let bit = 0; bit < 8; bit++) {
      this.control(0xa0);
      this.read();
      this.control(0x80);
    }
    this.control(ack ? 0 : 0x80);
    this.control(ack ? 0x20 : 0xa0);
    this.control(ack ? 0 : 0x80);
  }
  address(model: string, address: number, reading: boolean) {
    this.start();
    if (model === "x24c01") this.send((address << 1) | Number(reading));
    else {
      this.send(0xa0);
      this.send(address);
      if (reading) {
        this.start();
        this.send(0xa1);
      }
    }
  }
}
export const eepromFixture = (board: (typeof eepromCases)[number]) => {
  const { bytes } = bandaiFixture(
    board.mapper === 159 ? bandaiCases[2] : bandaiCases[1],
  );
  const initial = {
    mapper: board.mapper,
    ...(board.mapper === 16 ? { variant: "lz93d50" } : {}),
    eeprom_control: 0x60,
    eeprom: {
      model: board.model,
      page_size: board.page_size,
      phase: "idle",
      busy: false,
      bytes: [
        { address: board.capacity - 1, value: 0x96 },
        { address: 0, value: 0xa5 },
      ],
    },
  };
  const bus = new EepromBusFixture();
  bus.address(board.model, board.capacity - 1, true);
  bus.receive(true);
  bus.receive(false);
  bus.stop();
  // Branch immediately after the last proven serial data bit, before the next control write changes A.
  const lastRead = bus.events.findLastIndex(
    (e) => e.kind === "cpu-read" && e.address === 0x6000,
  );
  const prefix = bus.events
    .slice(0, lastRead + 1)
    .flatMap((event) =>
      event.kind === "cpu-write"
        ? [0xa9, event.value!, 0x8d, 0x0d, 0x80]
        : event.kind === "cpu-read" && event.address !== null
          ? [0xa9, 16, 0x2d, event.address & 255, event.address >> 8]
          : [],
    );
  bytes.set(
    [
      ...prefix,
      0xf0,
      8,
      0xa9,
      1,
      0x8d,
      8,
      0x80,
      0x4c,
      0xff,
      0xbf,
      0xa9,
      0xee,
      0x60,
    ],
    528 + 3 * 16384 + 0x100,
  );
  return { bytes, initial, bus };
};
