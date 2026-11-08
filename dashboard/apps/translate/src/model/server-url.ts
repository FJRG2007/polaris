/**
 * A server address as Translate keeps it: http or https, no credentials in it,
 * no trailing slash. Null when the text is not such an address. Shared by the
 * settings form and the server, so both accept the same addresses.
 */
export function normalizeServerUrl(raw: string): string | null {
    const text = raw.trim().replace(/\/+$/, "");
    if (!text) return null;
    try {
        const url = new URL(text);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        if (url.username || url.password) return null;
        return url.toString().replace(/\/+$/, "");
    } catch {
        return null;
    }
}
