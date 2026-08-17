"use client";

/**
 * Handing bytes to the browser as a file.
 *
 * One copy of it, because there were several and they differed in the details
 * that matter: the object URL has to be released or the blob is held for the
 * life of the tab, and an anchor that is never in the document still has to be
 * clicked rather than navigated to.
 *
 * For a file the server already holds, prefer a link with `download` on it - the
 * bytes never enter the page. This is for the other case: something the page
 * itself produced.
 */

export function downloadBytes(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
}
