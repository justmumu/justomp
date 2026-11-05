import { object } from "../dependencies/inventory";

export function valueAt(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    current = object(current)[key];
  }
  return current;
}
