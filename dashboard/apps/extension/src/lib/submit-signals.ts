/**
 * The signs that a form has gone without saying so, and the passwords this
 * extension made for a box.
 *
 * Pure enough to be asserted in a test without the page script around them. The
 * page script decides what to do with each answer; these only read the page.
 *
 * A sign-up written as a component rarely fires a submit. What is left to see is
 * the same three things an established password manager watches for: the button
 * pressed, a request the page sends right after that press, and the boxes going
 * out of sight - removed, or hidden by the next step of the form, which keeps
 * them in the page with the password still in them.
 */

/** Whether a box can be seen: in the page, and with nothing above it hidden. */
export function isShowing(box: HTMLInputElement): boolean {
    if (!box.isConnected) return false;
    let node: Element | null = box;
    while (node) {
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
        const view: Window | null = node.ownerDocument.defaultView;
        const style = view?.getComputedStyle(node);
        if (style && (style.display === "none" || /hidden|collapse/.test(style.visibility)))
            return false;
        const root = node.getRootNode();
        node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return true;
}

/** Whether the form somebody typed a password into is still in front of them,
 *  holding that password. Hidden counts as gone: a multi-step form hides the
 *  step it has finished with. */
export function stillHolds(boxes: readonly (HTMLInputElement | null)[], password: string): boolean {
    return boxes.some((box) => box !== null && box.value === password && isShowing(box));
}

/** The kinds of request a page sends a form with from a script. */
const SCRIPTED = new Set(["fetch", "xmlhttprequest", "beacon"]);

/** What of a resource timing entry is read here. `responseStatus` is missing in
 *  older browsers, and 0 where the browser will not say. */
export interface SentRequest {
    readonly initiatorType: string;
    /** When it started, in milliseconds since the epoch. */
    readonly startedAt: number;
    readonly responseStatus?: number;
}

/**
 * Whether a request the page sent is the form going: sent by a script, after a
 * press on the form's button and soon after it, and not answered with a
 * refusal. A sign-in that failed is not one to save.
 */
export function requestSendsForm(request: SentRequest, pressedAt: number, within: number): boolean {
    if (pressedAt === 0 || !SCRIPTED.has(request.initiatorType)) return false;
    if (request.startedAt < pressedAt || request.startedAt - pressedAt > within) return false;
    const status = request.responseStatus ?? 0;
    return status === 0 || status < 400;
}

/**
 * The passwords this extension made, per box, so the generator opened again on
 * the box shows the one that is in it rather than a new one - and copying it
 * copies what the box holds.
 */
export interface GeneratedPasswords {
    remember(box: HTMLInputElement, value: string): void;
    /** The password made for this box, while the box still holds it. */
    inBox(box: HTMLInputElement): string | null;
}

export function generatedPasswords(): GeneratedPasswords {
    const held = new WeakMap<HTMLInputElement, string>();
    return {
        remember(box, value) {
            if (value !== "") held.set(box, value);
        },
        inBox(box) {
            const value = held.get(box);
            return value !== undefined && box.value === value ? value : null;
        }
    };
}

/**
 * The name the page script answers under, in the extension's own isolated world,
 * when the worker types a password it made into a box from the right-click menu.
 * A page's own scripts cannot see that world, so they cannot call it.
 */
export const GENERATED_HOOK = "polarisGeneratedIn";
