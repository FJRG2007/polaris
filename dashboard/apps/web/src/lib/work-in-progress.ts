/**
 * What the reader has started on this page and not finished, seen from the
 * document itself so that no screen has to report it.
 *
 * Taking an update by itself is a reload, and a reload must never cost anybody
 * what they were doing - a provider half added, a task being edited, a setting
 * typed but not saved. Screens cannot be trusted to say so one by one (the one
 * that forgets is the one that loses somebody's work), so this watches the
 * shared layers every screen already goes through:
 *
 * - Typing: every `beforeinput`, `input` and `change` in the document. A field
 *   is dirty while its value differs from what it held before it was first
 *   touched - so a field typed into and put back is clean again. Text fields,
 *   checkboxes, selects and rich-text editors (contenteditable) alike.
 * - Requests: every non-GET `fetch` still under way, which is every save and
 *   every server action (Next sends those as POSTs).
 * - Dialogs: an open dialog, sheet or drawer is somebody in the middle of it.
 *
 * And so that a reload nobody chose - a crash, a manual F5, an update that
 * could not wait - still loses nothing, the dirty fields are written to session
 * storage when the page goes away and put back, by id or name, when they appear
 * again on the same address. A password or card field is never written down.
 *
 * A box that keeps its own draft (the chat composer) is marked with
 * `data-reload-keeps` and left to it.
 */

/** Marks a field, or anything around it, whose text survives a reload by its
 *  own means, such as the chat box writing every keystroke to its draft. */
export const RELOAD_KEEPS_ATTRIBUTE = "data-reload-keeps";

/** Where the dirty fields are written when the page goes away. */
const DRAFTS_KEY = "polaris.unsavedFields";

/** Older than this, written-down fields belong to some other visit. */
const DRAFTS_TTL_MS = 30 * 60 * 1000;

/** How long the new page keeps watching for a written-down field to appear -
 *  long enough for a dialog to be opened again by hand. */
const RESTORE_WINDOW_MS = 10 * 60 * 1000;

/** Inputs that are pressed rather than typed into. */
const PRESSED = new Set(["button", "reset", "submit", "image", "file", "hidden"]);

/** Open dialogs, sheets and drawers: Radix marks its content, a native dialog
 *  carries `open`. */
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], dialog[open]';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

/** What each touched field held before its first change. Unknown (`null`) when
 *  the first sign of it was a change already made, which counts as dirty. */
const initial = new WeakMap<Element, string | null>();
/** The touched fields, held weakly enough to let a closed dialog go. */
let touched = new Set<WeakRef<Element>>();
let pendingWrites = 0;
let installed = false;

/** The field an event belongs to: an input, textarea or select, or the root of
 *  a rich-text editor. Null for anything else and for what keeps its own draft. */
function fieldOf(target: EventTarget | null): Field | null {
    if (!(target instanceof Element)) return null;
    if (target.closest(`[${RELOAD_KEEPS_ATTRIBUTE}]`)) return null;
    if (target instanceof HTMLInputElement) return PRESSED.has(target.type) ? null : target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return target;
    if (target instanceof HTMLElement && target.isContentEditable) {
        // The editor's root, not the paragraph the caret is in.
        let root: HTMLElement = target;
        while (root.parentElement?.isContentEditable) root = root.parentElement;
        return root;
    }
    return null;
}

/** A field's value as one comparable string. A rich-text editor compares by its
 *  text: its markup also changes for decorations (a placeholder, a selection)
 *  that are not anything typed. */
function valueOf(field: Field): string {
    if (field instanceof HTMLInputElement) {
        return field.type === "checkbox" || field.type === "radio" ? String(field.checked) : field.value;
    }
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) return field.value;
    return field.textContent ?? "";
}

/** Remember what a field held before it changes. */
function noteBefore(event: Event): void {
    const field = fieldOf(event.target);
    if (!field || initial.has(field)) return;
    initial.set(field, valueOf(field));
    touched.add(new WeakRef(field));
}

/** A change seen with no `before` for it: the value it started from is gone. */
function noteChange(event: Event): void {
    const field = fieldOf(event.target);
    if (!field || initial.has(field)) return;
    // A checkbox or radio flips without any typing; its start is the opposite.
    if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")) {
        initial.set(field, field.type === "checkbox" ? String(!field.checked) : null);
    } else initial.set(field, null);
    touched.add(new WeakRef(field));
}

/** A form that was sent has nothing unsaved left in it. */
function noteSubmit(event: Event): void {
    if (!(event.target instanceof HTMLFormElement)) return;
    for (const element of event.target.elements) {
        if (initial.has(element)) initial.set(element, valueOf(element as Field));
    }
}

function isDirty(field: Element): boolean {
    if (!field.isConnected || !initial.has(field)) return false;
    const before = initial.get(field);
    return before === null || before !== valueOf(field as Field);
}

/** The fields on the page holding something the reader has not saved. */
export function dirtyFields(): Element[] {
    const live = new Set<WeakRef<Element>>();
    const dirty: Element[] = [];
    for (const ref of touched) {
        const field = ref.deref();
        if (!field) continue;
        live.add(ref);
        if (isDirty(field)) dirty.push(field);
    }
    touched = live;
    return dirty;
}

/** Whether a save or a server action is still on its way. */
export function writesUnderWay(): boolean {
    return pendingWrites > 0;
}

/** Whether a dialog, sheet or drawer is open. */
export function dialogOpen(): boolean {
    return document.querySelector(OPEN_DIALOG) !== null;
}

/** Count non-GET requests while they are in flight. Wraps `fetch` once. */
function watchWrites(): void {
    const original = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (method === "GET" || method === "HEAD") return original.call(this, input, init);
        pendingWrites += 1;
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            pendingWrites -= 1;
        };
        try {
            const sent = original.call(this, input, init);
            sent.then(settle, settle);
            return sent;
        } catch (error) {
            settle();
            throw error;
        }
    };
}

/** How a field is found again on the next page; null when it cannot be, or must
 *  not be written down at all. */
function keyOf(field: Element): string | null {
    if (field instanceof HTMLInputElement) {
        if (field.type === "password") return null;
        const complete = (field.autocomplete || "").toLowerCase();
        if (complete.startsWith("cc-") || complete === "one-time-code" || complete.includes("password")) return null;
    }
    if (field.id) return `#${CSS.escape(field.id)}`;
    const name = field.getAttribute("name");
    return name ? `${field.tagName.toLowerCase()}[name="${CSS.escape(name)}"]` : null;
}

interface WrittenField {
    readonly selector: string;
    readonly value: string;
    /** Rich text, put back as markup. */
    readonly rich: boolean;
}

function here(): string {
    return location.pathname + location.search;
}

/** Write every dirty field down for the page that replaces this one. */
export function saveUnsavedFields(): void {
    const fields: WrittenField[] = [];
    for (const field of dirtyFields()) {
        const selector = keyOf(field);
        if (!selector) continue;
        const rich = !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement);
        fields.push({ selector, value: rich ? field.innerHTML : valueOf(field as Field), rich });
    }
    try {
        if (fields.length === 0) window.sessionStorage.removeItem(DRAFTS_KEY);
        else window.sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ url: here(), at: Date.now(), fields }));
    } catch {
        // Full or refused storage: the reload checks still refused anything dirty.
    }
}

/** Put a value into a field React owns: through the native setter, then the
 *  events the component listens for, so its own state takes it. */
function fill(field: Element, written: WrittenField): boolean {
    if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")) {
        const checked = written.value === "true";
        if (field.checked !== checked) field.click();
        return true;
    }
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
        if (field.value !== "" && !(field instanceof HTMLSelectElement)) return true; // theirs wins
        const prototype = Object.getPrototypeOf(field) as object;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, written.value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }
    if (field instanceof HTMLElement && field.isContentEditable && written.rich) {
        if ((field.textContent ?? "").trim() !== "") return true;
        // Through the editor's own paste path, so its document model takes it.
        const data = new DataTransfer();
        data.setData("text/html", written.value);
        field.focus({ preventScroll: true });
        field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        return true;
    }
    return false;
}

/**
 * Put back the fields the last page wrote down, each as soon as it appears on
 * this address - including inside a dialog opened again later. Returns a stop.
 */
export function restoreUnsavedFields(): () => void {
    let pending: WrittenField[] = [];
    try {
        const raw = window.sessionStorage.getItem(DRAFTS_KEY);
        window.sessionStorage.removeItem(DRAFTS_KEY);
        const parsed = raw ? (JSON.parse(raw) as { url?: unknown; at?: unknown; fields?: unknown }) : null;
        if (
            parsed &&
            parsed.url === here() &&
            typeof parsed.at === "number" &&
            Date.now() - parsed.at < DRAFTS_TTL_MS &&
            Array.isArray(parsed.fields)
        ) {
            pending = (parsed.fields as WrittenField[]).filter(
                (field) => typeof field?.selector === "string" && typeof field.value === "string"
            );
        }
    } catch {
        return () => {};
    }
    if (pending.length === 0) return () => {};
    const settle = () => {
        pending = pending.filter((written) => {
            let target: Element | null = null;
            try {
                target = document.querySelector(written.selector);
            } catch {
                return false;
            }
            return !(target && fill(target, written));
        });
        if (pending.length === 0) stop();
    };
    const observer = new MutationObserver(settle);
    const timer = setTimeout(() => stop(), RESTORE_WINDOW_MS);
    function stop() {
        observer.disconnect();
        clearTimeout(timer);
    }
    observer.observe(document.body, { childList: true, subtree: true });
    settle();
    return stop;
}

/** Start watching. Idempotent; the shell calls it once per page. */
export function watchWorkInProgress(): void {
    if (installed || typeof window === "undefined") return;
    installed = true;
    document.addEventListener("focusin", noteBefore, true);
    document.addEventListener("beforeinput", noteBefore, true);
    document.addEventListener("keydown", noteBefore, true);
    document.addEventListener("pointerdown", noteBefore, true);
    document.addEventListener("input", noteChange, true);
    document.addEventListener("change", noteChange, true);
    document.addEventListener("submit", noteSubmit, true);
    // Leaving for any reason - a reload, closing the tab, an update - writes the
    // unsaved fields down first.
    window.addEventListener("pagehide", saveUnsavedFields);
    watchWrites();
}

/** For tests: forget everything this page has seen. */
export function resetWorkInProgress(): void {
    touched = new Set();
    pendingWrites = 0;
}
