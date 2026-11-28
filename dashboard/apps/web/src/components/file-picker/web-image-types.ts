/**
 * Which of the four types a web image can be (PNG, JPEG, WebP, GIF) a screen
 * takes, read from its file input's `accept`.
 *
 * Empty means the "Search the web" tab is not offered: the screen takes no
 * images, takes only one this cannot hand back (an SVG), or points at files
 * where they are and has nowhere to put a new one.
 */

const ALL = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const BY_ENTRY: Readonly<Record<string, string>> = {
    "image/png": "image/png",
    ".png": "image/png",
    "image/jpeg": "image/jpeg",
    "image/jpg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    "image/webp": "image/webp",
    ".webp": "image/webp",
    "image/gif": "image/gif",
    ".gif": "image/gif"
};

export function webImageTypes(accept: string | undefined, storageOnly = false): string[] {
    if (storageOnly) return [];
    const wanted = (accept ?? "")
        .split(",")
        .map((one) => one.trim().toLowerCase())
        .filter(Boolean);
    if (wanted.length === 0 || wanted.includes("image/*") || wanted.includes("*/*")) return [...ALL];
    return ALL.filter((type) => wanted.some((one) => BY_ENTRY[one] === type));
}
