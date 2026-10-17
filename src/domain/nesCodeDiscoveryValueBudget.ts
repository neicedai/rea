/** One journal owns capacity admission and rollback of all discovery evidence registries. */
export class NesDiscoveryValueBudget {
  private readonly undo: (() => void)[] = [];
  private depth = 0;
  failed = false;
  constructor(
    readonly graph: { value_state_records: number },
    readonly maximum: number,
  ) {}
  begin(): { mark: number; records: number; failed: boolean } {
    this.depth++;
    return {
      mark: this.undo.length,
      records: this.graph.value_state_records,
      failed: this.failed,
    };
  }
  commit(): void {
    this.depth--;
    if (this.depth === 0) this.undo.length = 0;
  }
  rollback(checkpoint: {
    mark: number;
    records: number;
    failed: boolean;
  }): void {
    for (let index = this.undo.length - 1; index >= checkpoint.mark; index--)
      this.undo[index]!();
    this.undo.length = checkpoint.mark;
    this.graph.value_state_records = checkpoint.records;
    this.failed = checkpoint.failed;
    this.depth--;
    if (this.depth === 0) this.undo.length = 0;
  }
  run<T>(operation: () => T): Result<T, { kind: "value-state-budget" }> {
    const checkpoint = this.begin();
    try {
      const value = operation();
      if (this.failed) {
        this.rollback(checkpoint);
        this.failed = true;
        return err({ kind: "value-state-budget" });
      }
      this.commit();
      return ok(value);
    } catch (error) {
      this.rollback(checkpoint);
      throw error;
    }
  }
  delete<T>(set: Set<T>, value: T): void {
    if (!set.has(value)) return;
    this.record(() => {
      set.add(value);
    });
    set.delete(value);
  }
  reserve(records: number): boolean {
    if (this.failed) return false;
    if (records > this.maximum - this.graph.value_state_records) {
      this.failed = true;
      return false;
    }
    this.graph.value_state_records += records;
    return true;
  }
  record(undo: () => void): void {
    if (this.depth > 0) this.undo.push(undo);
  }
  append<T>(array: T[], value: T): void {
    const length = array.length;
    this.record(() => {
      array.length = length;
    });
    array.push(value);
  }
  mapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
    const exists = map.has(key),
      previous = map.get(key);
    this.record(() => {
      if (exists) map.set(key, previous!);
      else map.delete(key);
    });
    map.set(key, value);
  }
  weakSet<K extends WeakKey, V>(map: WeakMap<K, V>, key: K, value: V): void {
    const exists = map.has(key),
      previous = map.get(key);
    this.record(() => {
      if (exists) map.set(key, previous!);
      else map.delete(key);
    });
    map.set(key, value);
  }
  add<T>(set: Set<T>, value: T): void {
    if (set.has(value)) return;
    this.record(() => {
      set.delete(value);
    });
    set.add(value);
  }
}
export const unlimitedNesDiscoveryValueBudget = () =>
  new NesDiscoveryValueBudget({ value_state_records: 0 }, Infinity);
import { err, ok, type Result } from "./result.js";
