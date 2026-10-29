/**
 * Naming what somebody pasted into the explorer.
 *
 * A screenshot or a picture copied in a browser reaches the page as a file
 * called `image.png` - every time - so a second paste would clash with the
 * first and ask what to do about it. Those get a dated name instead. A file
 * copied in the system's own file manager keeps the name it had there.
 */

import type { UploadItem } from "@/lib/drop-items";

/** The name browsers give an image that was copied rather than a file. */
const GENERIC = /^image\.([a-z0-9]+)$/i;

/** Extensions for the image types a clipboard carries, where they differ from the subtype. */
const EXTENSIONS: Record<string, string> = { jpeg: "jpg", "svg+xml": "svg" };

/** `2026-10-29 15.04.09` in local time - no colons, which Windows refuses in a name. */
function stampOf(at: Date): string {
    const two = (value: number) => String(value).padStart(2, "0");
    const day = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
    return `${day} ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}`;
}

function extensionOf(file: File, generic: RegExpExecArray | null): string {
    if (generic?.[1]) return generic[1].toLowerCase();
    const subtype = file.type.split("/")[1]?.toLowerCase() ?? "";
    return EXTENSIONS[subtype] ?? (/^[a-z0-9]+$/.test(subtype) ? subtype : "bin");
}

/** Upload items for pasted files, with `prefix` ("Pasted image") naming the unnamed ones. */
export function pastedItems(files: readonly File[], prefix: string, at: Date): UploadItem[] {
    const stamp = stampOf(at);
    let unnamed = 0;
    const total = files.filter((file) => !file.name || GENERIC.test(file.name)).length;
    return files.map((file) => {
        const generic = GENERIC.exec(file.name);
        if (file.name && !generic) return { file, relPath: file.name };
        unnamed += 1;
        const suffix = total > 1 ? ` (${unnamed})` : "";
        return { file, relPath: `${prefix} ${stamp}${suffix}.${extensionOf(file, generic)}` };
    });
}
