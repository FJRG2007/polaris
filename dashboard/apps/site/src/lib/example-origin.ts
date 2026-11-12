/** Where an installed Polaris answers, in examples: a placeholder, never a real host. */
export const EXAMPLE_ORIGIN = "https://polaris.example.com";
export const EXAMPLE_HOST = new URL(EXAMPLE_ORIGIN).host;

/**
 * What a reader typed as their own Polaris, as an origin (`https://polaris.home.lan`),
 * or null when it is not one. A bare host means https; only http and https are
 * accepted, and nothing but the origin is kept - no path, query or credentials.
 */
export function readerOrigin(typed: string): string | null {
    const text = typed.trim();
    if (!text || text.length > 253 || /\s/.test(text)) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || !url.hostname) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (!/^[a-z0-9.\-[\]:]+$/i.test(url.hostname)) return null;
    return url.origin;
}

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
