/** A file name a browser keeps as typed: ASCII, no separators. */
export function exportFileName(title: string, id: string, extension: string): string {
    const slug = title
        .normalize("NFKD")
        .replace(/[^\x20-\x7e]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return `${slug || "chat"}-${id.slice(0, 8)}.${extension}`;
}
