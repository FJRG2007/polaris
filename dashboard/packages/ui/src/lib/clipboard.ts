/**
 * Reading the clipboard for a menu's Paste, and whether it can be read at all.
 *
 * A Paste row in a menu is not the paste keys: the browser hands a page the
 * clipboard only when it asks inside the press, and may refuse it. This reads
 * what a paste event would carry - the text, HTML and pictures - and says why
 * when it cannot, so the menu can name the keys that always work instead of
 * doing nothing. Shared by the dashboard's menus and the document editor, which
 * cannot import the dashboard. Browser-only; nothing here touches the page.
 */

/** What is on the clipboard: the text, HTML when there is some, and pictures. */
export interface ClipboardContents {
    readonly text: string;
    readonly html: string | null;
    /** Pictures on the clipboard (a screenshot, a copied image), as a paste event carries them. */
    readonly files: readonly File[];
}

/** Why the clipboard could not be read: the browser or app said no, or has no way to ask. */
export type ClipboardRefusal = "denied" | "unsupported";

export type ClipboardRead =
    | { readonly ok: true; readonly contents: ClipboardContents }
    | { readonly ok: false; readonly reason: ClipboardRefusal };

function refusalOf(error: unknown): ClipboardRefusal {
    return (error as { name?: unknown } | null)?.name === "NotAllowedError" ? "denied" : "unsupported";
}

/** "image.png" for a picture the clipboard gives no name. */
function pictureName(type: string): string {
    const extension = type.split("/")[1]?.split(/[+;]/)[0] || "png";
    return `image.${extension === "jpeg" ? "jpg" : extension}`;
}

async function clipboardItems(items: readonly ClipboardItem[]): Promise<ClipboardContents> {
    let text = "";
    let html: string | null = null;
    const files: File[] = [];
    for (const item of items) {
        if (!html && item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
        if (!text && item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
        const picture = item.types.find((type) => type.startsWith("image/"));
        if (picture) {
            const blob = await item.getType(picture);
            files.push(new File([blob], pictureName(picture), { type: picture }));
        }
    }
    return { text, html, files };
}

/**
 * Reads everything a paste would carry: `clipboard.read()` first, for HTML and
 * pictures; `readText()` where that is missing or failed (older Firefox reads
 * text only); `fallbackText` last, for a host with a clipboard of its own (the
 * desktop app) where the page is refused it altogether - a page on a plain-http
 * address has no clipboard API at all.
 */
export async function readClipboard(
    fallbackText?: () => Promise<string | null | undefined> | undefined
): Promise<ClipboardRead> {
    let reason: ClipboardRefusal = "unsupported";
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (typeof clipboard?.read === "function") {
        try {
            return { ok: true, contents: await clipboardItems(await clipboard.read()) };
        } catch (error) {
            reason = refusalOf(error);
        }
    }
    // Not again after a refusal: the same permission answers both, and Firefox
    // and Safari would show the person their paste prompt a second time.
    if (reason !== "denied" && typeof clipboard?.readText === "function") {
        try {
            return { ok: true, contents: { text: await clipboard.readText(), html: null, files: [] } };
        } catch (error) {
            reason = refusalOf(error);
        }
    }
    let text: string | null | undefined = null;
    try {
        text = await fallbackText?.();
    } catch {
        text = null;
    }
    if (typeof text === "string") return { ok: true, contents: { text, html: null, files: [] } };
    return { ok: false, reason };
}

/** The paste keys here, for a hint that names them: "Cmd+V" on Apple devices. */
export function pasteKeys(): string {
    if (typeof navigator === "undefined") return "Ctrl+V";
    return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Cmd+V" : "Ctrl+V";
}

/**
 * Tells `onChange` whether a menu can never read the clipboard here: no
 * clipboard API (a plain-http address, an old browser), or the person refused
 * it for good. A browser that can only be asked by trying counts as readable.
 * Returns the function that stops listening.
 */
export function watchClipboardBlocked(onChange: (blocked: boolean) => void): () => void {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        onChange(true);
        return () => undefined;
    }
    let status: PermissionStatus | null = null;
    let stopped = false;
    const read = () => status && onChange(status.state === "denied");
    navigator.permissions
        ?.query({ name: "clipboard-read" as PermissionName })
        .then((answer) => {
            if (stopped) return;
            status = answer;
            read();
            answer.addEventListener("change", read);
        })
        .catch(() => undefined);
    return () => {
        stopped = true;
        status?.removeEventListener("change", read);
    };
}
