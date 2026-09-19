/**
 * Which mailbox a new message goes from when nobody has said.
 *
 * The mailbox on screen, if the screen is one mailbox - its inbox or any of its
 * folders. Otherwise the last one somebody was in or sent from, remembered in
 * this browser so it survives moving around Mail and a reload. Otherwise the
 * first. A reply never asks: it goes from the mailbox its message arrived in,
 * which the seed already names.
 *
 * Only ever a mailbox on the shelf being worked from. The remembered one is kept
 * per shelf, and checked against the shelf's own list before it is used, so a
 * personal address is never offered for a message written on an organization's
 * shelf - or one that has since been removed.
 */

/** The fields of a folder this needs. */
interface FolderOwner {
    readonly id: string;
    readonly accountId: string;
}

/** The mailbox an address in Mail is inside, when it is inside exactly one. */
export function mailboxInView(pathname: string, folders: readonly FolderOwner[]): string | null {
    const [, root, kind, id] = pathname.split("/");
    if (root !== "mail" || !id) return null;
    const named = safeDecode(id);
    if (kind === "a") return named;
    if (kind === "f") return folders.find((folder) => folder.id === named)?.accountId ?? null;
    return null;
}

/**
 * The mailbox to start a message on.
 *
 * @param visible - The mailboxes on the current shelf, in the rail's order.
 */
export function defaultSender({
    inView,
    remembered,
    visible
}: {
    inView: string | null;
    remembered: string | null;
    visible: readonly { readonly id: string }[];
}): string {
    const here = (id: string | null) => id !== null && visible.some((one) => one.id === id);
    if (here(inView)) return inView as string;
    if (here(remembered)) return remembered as string;
    return visible[0]?.id ?? "";
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** Kept per shelf: the same browser works from more than one. */
function keyFor(shelf: string): string {
    return `polaris.mail.sender.${shelf}`;
}

/**
 * The mailbox last used on this shelf, in this browser.
 *
 * A convenience and nothing more, so a browser that keeps nothing - a private
 * window, blocked storage - reads as nothing remembered rather than as a fault.
 */
export function rememberedSender(shelf: string): string | null {
    try {
        return window.localStorage.getItem(keyFor(shelf));
    } catch {
        return null;
    }
}

export function rememberSender(shelf: string, accountId: string): void {
    if (!accountId) return;
    try {
        window.localStorage.setItem(keyFor(shelf), accountId);
    } catch {
        // Not kept. The next message starts on the first mailbox, which is what
        // it did before anything was remembered.
    }
}
