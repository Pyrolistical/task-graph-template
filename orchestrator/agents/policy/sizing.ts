export interface Sized {
  name: string;
  index: number;
  idle: boolean;
}

export function taken(indexes: number[], target: number): number[] {
  const used = new Set(indexes);
  const added: number[] = [];

  for (let index = 1; used.size < target; index += 1) {
    if (!used.has(index)) {
      used.add(index);
      added.push(index);
    }
  }

  return added;
}

export function dropped(slots: Sized[], target: number): string[] {
  return slots
    .filter((slot) => slot.idle)
    .sort((one, two) => two.index - one.index)
    .slice(0, Math.max(0, slots.length - target))
    .map((slot) => slot.name);
}
