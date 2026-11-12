/** Short unique id. Does not rely on crypto.randomUUID, which is unavailable on plain-HTTP origins. */
export function uid(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}${rand}`;
}
