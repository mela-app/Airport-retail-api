/**
 * Safe record helpers. Lookups go through `Object.hasOwn`, so a key such as `__proto__` or `constructor`
 * never reaches the prototype chain. The codebase uses these (or `Map`) instead of `record[key]`.
 */

/** Own-property lookup: the value for `key`, or `undefined` when the record has no such own key. */
export function getOwn<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(record, key) ? (Reflect.get(record, key) as V) : undefined;
}

/** Own-property lookup with a default. */
export function getOr<V>(record: Readonly<Record<string, V>>, key: string, fallback: NoInfer<V>): V {
  const value = getOwn(record, key);
  return value === undefined ? fallback : value;
}

/** Map over the values of a record, keeping its keys. */
export function mapValues<K extends string, V, R>(
  record: Readonly<Record<K, V>>,
  fn: (value: V, key: K) => R,
): Record<K, R> {
  return Object.fromEntries(
    (Object.entries(record) as [K, V][]).map(([key, value]) => [key, fn(value, key)]),
  ) as Record<K, R>;
}

/** Sum of a record's numeric values. */
export function sumValues(record: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(record)) total += value;
  return total;
}
