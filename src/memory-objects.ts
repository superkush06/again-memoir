export const MEMORY_OBJECT_CATEGORIES = [
  "laptop",
  "computer",
  "phone",
  "drink-can",
  "chip-bag",
  "water-bottle",
  "box",
  "backpack",
] as const;
export type MemoryObjectCategory = (typeof MEMORY_OBJECT_CATEGORIES)[number];

/** Inferred dimensions in metres, not measurements of the original object. */
export interface MemoryObjectSpec {
  category: MemoryObjectCategory;
  confidence: number;
  color: string;
  dimensions: [number, number, number];
  rotation?: [number, number, number];
}

export function classifyMemoryObject(
  label: string,
): MemoryObjectCategory | undefined {
  const text = label.toLowerCase().replace(/[_-]/g, " ");
  if (/\b(laptop|notebook computer|macbook)\b/.test(text)) return "laptop";
  if (/\b(computer|monitor|desktop pc|desktop tower|imac)\b/.test(text))
    return "computer";
  if (/\b(phone|cellphone|cell phone|smartphone|iphone)\b/.test(text))
    return "phone";
  if (
    /\b((drink|soda|beverage|beer|aluminum|aluminium|energy drink) can|can of (soda|beer)|coke can)\b/.test(
      text,
    )
  )
    return "drink-can";
  if (
    /\b((chip|chips|crisp|crisps|snack) (bag|packet)|bag of (chips|crisps))\b/.test(
      text,
    )
  )
    return "chip-bag";
  if (
    /\b((water|plastic|drink|drinking) bottle|bottle of water)\b/.test(text) ||
    text.trim() === "bottle"
  )
    return "water-bottle";
  if (/\b(backpack|rucksack|knapsack|bookbag|school bag)\b/.test(text))
    return "backpack";
  if (/\b(box|carton|cardboard package)\b/.test(text)) return "box";
  return undefined;
}

export function isMemoryObjectSpec(value: unknown): value is MemoryObjectSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).every((key) =>
      ["category", "confidence", "color", "dimensions", "rotation"].includes(
        key,
      ),
    ) &&
    MEMORY_OBJECT_CATEGORIES.includes(item.category as MemoryObjectCategory) &&
    typeof item.confidence === "number" &&
    Number.isFinite(item.confidence) &&
    item.confidence >= 0 &&
    item.confidence <= 1 &&
    typeof item.color === "string" &&
    /^#[a-f\d]{6}$/i.test(item.color) &&
    Array.isArray(item.dimensions) &&
    item.dimensions.length === 3 &&
    item.dimensions.every(
      (n) =>
        typeof n === "number" && Number.isFinite(n) && n >= 0.004 && n <= 3,
    ) &&
    (item.rotation === undefined ||
      (Array.isArray(item.rotation) &&
        item.rotation.length === 3 &&
        item.rotation.every(
          (n) =>
            typeof n === "number" &&
            Number.isFinite(n) &&
            Math.abs(n) <= Math.PI * 2,
        )))
  );
}
