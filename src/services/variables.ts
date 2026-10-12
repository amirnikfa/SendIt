import { randomUUID, randomInt } from 'node:crypto';
import type { Pair } from '../shared/models';

/** Last enabled value wins within a scope. Later scopes take precedence. */
export function variableMap(...scopes: Pair[][]): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const scope of scopes)
    for (const row of scope) if (row.enabled && row.key) values[row.key] = row.value;
  return values;
}

export function interpolate(
  text: string,
  values: Record<string, string>,
  stack: string[] = [],
): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
    if (key === '$guid' || key === '$randomUUID') return randomUUID();
    if (key === '$timestamp') return String(Math.floor(Date.now() / 1000));
    if (key === '$isoTimestamp') return new Date().toISOString();
    if (key === '$randomInt') return String(randomInt(1001));
    if (!Object.hasOwn(values, key))
      throw new Error(
        `Unresolved variable: {{${key}}}. Add it to the selected environment or another variable scope.`,
      );
    if (stack.includes(key) || stack.length > 20)
      throw new Error(`Circular variable reference: ${[...stack, key].join(' → ')}`);
    return interpolate(String(values[key]), values, [...stack, key]);
  });
}

export function resolveObject<T>(value: T, values: Record<string, string>): T {
  if (typeof value === 'string') return interpolate(value, values) as T;
  if (Array.isArray(value)) return value.map((item) => resolveObject(item, values)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveObject(item, values)]),
    ) as T;
  return value;
}

export function redact(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of [...new Set(secrets)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length))
    result = result.split(secret).join('[REDACTED]');
  return result.replace(/(authorization\s*[:=]\s*|bearer\s+|basic\s+)[^\s,;]+/gi, '$1[REDACTED]');
}
