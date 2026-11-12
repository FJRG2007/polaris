import { parseHostAddress } from "./host-store";

/** Where an installed Polaris answers, in examples: a placeholder, never a real host. */
export const EXAMPLE_ORIGIN = "https://polaris.example.com";
export const EXAMPLE_HOST = new URL(EXAMPLE_ORIGIN).host;

/**
 * What a reader typed as their own Polaris, as an origin (`https://polaris.home.lan`),
 * or null when it is not one. A bare host means https; only http and https are
 * accepted, and nothing but the origin is kept - no path, query or credentials.
 */
export const readerOrigin = parseHostAddress;

const escapeHtml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * An example with the placeholder Polaris swapped for the reader's own: the full
 * origin where the example has one, and the bare host everywhere else. `html`
 * escapes the replacement for markup.
 */
export function withReaderOrigin(text: string, origin: string | null, html = false): string {
    if (!origin || origin === EXAMPLE_ORIGIN) return text;
    const host = new URL(origin).host;
    const esc = html ? escapeHtml : (value: string) => value;
    return text.split(EXAMPLE_ORIGIN).join(esc(origin)).split(EXAMPLE_HOST).join(esc(host));
}
