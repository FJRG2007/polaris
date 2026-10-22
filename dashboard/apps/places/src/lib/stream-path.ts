/** The path and query of a stream URL, which is what a camera row stores. */
export function streamPathOf(url: string | null): string {
    if (!url) return "";
    try {
        const parsed = new URL(url);
        return `${parsed.pathname}${parsed.search}`;
    } catch {
        return "";
    }
}
