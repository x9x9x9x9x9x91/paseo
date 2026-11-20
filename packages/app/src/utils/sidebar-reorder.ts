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
 * current order lacks goes at the end.
 */
export function mergeByPosition(input: {
  currentOrder: readonly string[];
  reorderedVisibleKeys: readonly string[];
}): string[] {
  const reorderedSet = new Set(input.reorderedVisibleKeys);
  let next = 0;
  const merged = input.currentOrder.map((key) =>
    reorderedSet.has(key) && next < input.reorderedVisibleKeys.length
      ? input.reorderedVisibleKeys[next++]
      : key,
  );
  return [...merged, ...input.reorderedVisibleKeys.slice(next)];
}
