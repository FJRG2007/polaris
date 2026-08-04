/** stdlib-only GitHub Actions helpers for entryPost.ts (no node_modules). */

export function getState(name: string): string {
  return process.env[`STATE_${name}`] ?? "";
}

export function info(message: string): void {
  console.log(message);
}

export function warning(message: string): void {
  console.log(`::warning::${message}`);
}
