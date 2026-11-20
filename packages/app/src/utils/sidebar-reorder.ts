export function mergeWithRemainder(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): string[] {
  const reorderedSet = new Set(input.reorderedVisibleKeys);
  const remainder = input.currentOrder.filter((key) => !reorderedSet.has(key));
  return [...input.reorderedVisibleKeys, ...remainder];
}

export function hasVisibleOrderChanged(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): boolean {
  const visibleSet = new Set(input.reorderedVisibleKeys);
  const currentVisible = input.currentOrder.filter((key) => visibleSet.has(key));
  if (currentVisible.length !== input.reorderedVisibleKeys.length) {
    return true;
  }
  return input.reorderedVisibleKeys.some((key, index) => currentVisible[index] !== key);
}

/**
 * `currentOrder` with its keys that are in `reorderedVisibleKeys` put in that order, each taking a
 * place one of them had: a key not in the reordered list keeps its place. A reordered key the
 * current order lacks goes just before the reordered key that follows it, or at the end when none
 * does, so it never pushes a reordered key past a key that kept its place.
 */
export function mergeByPosition(input: {
  currentOrder: readonly string[];
  reorderedVisibleKeys: readonly string[];
}): string[] {
  const currentSet = new Set(input.currentOrder);
  const runs: string[][] = [];
  let pending: string[] = [];
  for (const key of input.reorderedVisibleKeys) {
    pending.push(key);
    if (currentSet.has(key)) {
      runs.push(pending);
      pending = [];
    }
  }
  const reorderedSet = new Set(input.reorderedVisibleKeys);
  let next = 0;
  const merged = input.currentOrder.flatMap((key) =>
    reorderedSet.has(key) && next < runs.length ? runs[next++] : [key],
  );
  return [...merged, ...runs.slice(next).flat(), ...pending];
}
