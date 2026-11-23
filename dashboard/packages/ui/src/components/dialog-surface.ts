/**
 * A dialog's classes, apart from the dialog itself, so a surface that cannot
 * use the Radix dialog (the launcher drawn into another page's shadow root, the
 * desktop's search window) draws the very same box. No React and no Radix here.
 */

/** The page dimmed behind anything modal. It fades out as well as in, so a
 *  dialog closing does not leave the page snapping back to full light under it. */
export const DIALOG_OVERLAY =
    "app-no-drag fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=closed]:duration-fast";

/**
 * How a centred dialog arrives and leaves.
 *
 * It is centred with a -50% translate, and the enter and exit keyframes write
 * `transform` as well - which on their own replace the centring, so the first
 * frame of an opening dialog sat half its size down and to the right and swept
 * into place. Seeding the keyframes' translate with the element's own keeps the
 * centring (and any caller's own placement, such as a dialog docked to an edge
 * with `translate-x-0`) and animates only the fade and the small scale on top
 * of it. A caller's own `slide-in-from-*` still wins, being behind a variant.
 */
export const CENTRED_MOTION =
    "[--tw-enter-translate-x:var(--tw-translate-x)] [--tw-enter-translate-y:var(--tw-translate-y)] [--tw-exit-translate-x:var(--tw-translate-x)] [--tw-exit-translate-y:var(--tw-translate-y)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:zoom-out-[0.98] data-[state=closed]:duration-fast";

/** The corner close button every dialog and sheet carries. */
export const DIALOG_CLOSE =
    "absolute end-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors duration-fast hover:bg-card-hover hover:text-foreground active:bg-muted";

/**
 * How a dialog sits on a phone, where a box floating in the middle of a small
 * screen is the desktop's habit rather than the phone's.
 *
 * - `sheet`: rises from the bottom edge, full width, its top corners rounded -
 *   where the thumb already is. A confirmation, a short form.
 * - `full`: takes the whole screen, as Discord and WhatsApp open "new message"
 *   or a picker on a phone. Anything with a list to search or a lot to fill in.
 * - `keep`: what the caller drew, untouched: a drawer docked to an edge, or a
 *   dialog that already says where it goes on a phone.
 *
 * Left out, a dialog the caller placed itself (`translate-x-0`) is `keep`, a
 * dialog the caller made wide (`max-w-2xl` and up) is `full`, and every other
 * is `sheet`: the width a caller asked for on a computer is the
 * one thing every dialog already says about how much it holds. From `sm` up
 * nothing changes.
 */
export type PhoneLayout = "sheet" | "full" | "keep";

export const PHONE_SHEET =
    "max-sm:bottom-0 max-sm:left-0 max-sm:right-0 max-sm:top-auto max-sm:w-full max-sm:max-w-none max-sm:max-h-[92dvh] max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[calc(1.25rem+var(--safe-bottom))] max-sm:data-[state=open]:slide-in-from-bottom-8 max-sm:data-[state=closed]:slide-out-to-bottom-8";

export const PHONE_FULL =
    "max-sm:bottom-0 max-sm:left-0 max-sm:right-0 max-sm:top-0 max-sm:h-dvh max-sm:w-full max-sm:max-w-none max-sm:max-h-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0 max-sm:pt-[calc(1.25rem+var(--safe-top))] max-sm:pb-[calc(1.25rem+var(--safe-bottom))] max-sm:data-[state=open]:slide-in-from-bottom-8 max-sm:data-[state=closed]:slide-out-to-bottom-8";

export const PHONE_CLASSES: Record<PhoneLayout, string> = {
    sheet: PHONE_SHEET,
    full: PHONE_FULL,
    keep: ""
};

/**
 * A centred dialog's own box. Centred, so a dialog taller than the window would
 * hang off both ends of it with no way to reach either - including the buttons.
 * Capping it and letting the content scroll is what keeps a long one usable on
 * a laptop in a small window and on a phone. Its width leaves a margin on each
 * side, so in a narrow window (a phone, the extension's side panel) it never
 * touches the edges.
 */
export const DIALOG_SURFACE =
    "fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-xl border border-border-strong bg-elevated p-5 shadow-modal";
