/**
 * Finding a page's inputs where pages actually keep them.
 *
 * `document.querySelectorAll("input")` sees the light DOM of one document and
 * nothing else, and a growing share of sign-ins live outside it: a design
 * system's `<x-text-field>` keeps its `<input>` inside a shadow root, and a site
 * that embeds its own sign-in page in a frame keeps the whole form in another
 * document. The walk below reaches both, in the order a reader meets the boxes -
 * which matters, because the username is looked for among the boxes BEFORE the
 * password.
 *
 * Only frames of the page's own origin are entered. A cross-origin frame cannot
 * be read from here at all, and is somebody else's page in any case; offering a
 * login inside one is the shape of a clickjacking.
 *
 * Kept apart from the inline script so the corpus in `test/page-scan.test.ts`
 * can run real markup through it - the same code the page runs, not a copy.
 */

import type { FieldFacts } from "@/lib/fields";

/** The closed shadow roots a browser will hand an extension: Chrome's
 *  `dom.openOrClosedShadowRoot`, where it exists. */
export type ShadowOpener = (element: Element) => ShadowRoot | null;

/** Every input on the page, and every tree they were found in. */
export interface Scan {
    readonly inputs: HTMLInputElement[];
    /** The shadow roots and frame documents walked, so the caller can watch
     *  them for changes and listen for their submits - a `submit` event does not
     *  cross a shadow boundary, and nothing crosses a frame's. */
    readonly trees: (ShadowRoot | Document)[];
    /** Every frame met, loaded or not: its document is replaced when it loads,
     *  and nothing in the page around it changes to say so. */
    readonly frames: HTMLIFrameElement[];
}

/** Whether a node is an input, in any frame: `instanceof` is false for an
 *  element from another document's realm. */
export function isInput(node: unknown): node is HTMLInputElement {
    return (node as Node | null)?.nodeName === "INPUT";
}

/** Walk the page, its open (and, where the browser allows, closed) shadow
 *  roots, and its same-origin frames. */
export function scanInputs(doc: Document, opener?: ShadowOpener): Scan {
    const inputs: HTMLInputElement[] = [];
    const trees: (ShadowRoot | Document)[] = [];
    const frames: HTMLIFrameElement[] = [];

    const visit = (root: Document | ShadowRoot): void => {
        const walker = (root.ownerDocument ?? (root as Document)).createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT
        );
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const element = node as Element;
            if (isInput(element)) inputs.push(element);
            const shadow =
                element.shadowRoot ??
                (opener && element.localName.includes("-") ? closedRoot(opener, element) : null);
            if (shadow) {
                trees.push(shadow);
                visit(shadow);
            }
            if (element.nodeName === "IFRAME" || element.nodeName === "FRAME") {
                frames.push(element as HTMLIFrameElement);
                const inner = frameDocument(element as HTMLIFrameElement);
                if (inner) {
                    trees.push(inner);
                    visit(inner);
                }
            }
        }
    };
    visit(doc);
    return { inputs, trees, frames };
}

/** A closed root, or null where the browser refuses to say. */
function closedRoot(opener: ShadowOpener, element: Element): ShadowRoot | null {
    try {
        return opener(element) ?? null;
    } catch {
        return null;
    }
}

/** A frame's document, when it is the page's own origin and has loaded. */
function frameDocument(frame: HTMLIFrameElement): Document | null {
    try {
        const inner = frame.contentDocument;
        return inner?.documentElement ? inner : null;
    } catch {
        return null;
    }
}

/** How far a frame's own coordinates are from the top page's, summed up the
 *  chain of frames: a mark drawn on the top page has to be moved by that much. */
export function frameOffset(field: Element): { x: number; y: number } {
    let x = 0;
    let y = 0;
    let view = field.ownerDocument.defaultView;
    while (view && view !== view.parent) {
        const frame = view.frameElement;
        if (!frame) break;
        const box = frame.getBoundingClientRect();
        x += box.left + frame.clientLeft;
        y += box.top + frame.clientTop;
        view = frame.ownerDocument.defaultView;
    }
    return { x, y };
}

/** How many levels up a form written without `<form>` is looked for. */
const PANEL_DEPTH = 5;

/** The element that stands for a field's form: the form, or the panel a few
 *  levels up when there is none. */
export function formOf(field: HTMLInputElement): Element | null {
    if (field.form) return field.form;
    let around: Element | null = field;
    for (let step = 0; step < PANEL_DEPTH && around; step += 1) {
        around = around.parentElement ?? hostOf(around);
    }
    return around;
}

/** The element a shadow root hangs from, which is where a walk up continues. */
function hostOf(element: Element): Element | null {
    const root = element.getRootNode();
    return root.nodeType === Node.DOCUMENT_FRAGMENT_NODE
        ? ((root as ShadowRoot).host ?? null)
        : null;
}

/** One step up, crossing out of a shadow root into the element it hangs from. */
export function upFrom(node: Node): Node | null {
    return node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
        ? ((node as ShadowRoot).host ?? null)
        : node.parentNode;
}

/** The text of the elements an `aria-labelledby` names, in the field's own tree. */
function labelledBy(field: HTMLInputElement): string {
    const ids = (field.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    if (ids.length === 0) return "";
    const root = field.getRootNode() as Document | ShadowRoot;
    return ids.map((id) => root.getElementById?.(id)?.textContent ?? "").join(" ");
}

/** What a form says it does: the text of its submit buttons, and its own names. */
function formWords(field: HTMLInputElement): string {
    const form = formOf(field);
    if (!form) return "";
    const buttons = [
        ...form.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")
    ]
        .filter((button) => {
            // A button that is a link to another page is not what the form does.
            const type = (button.getAttribute("type") ?? "").toLowerCase();
            return button.nodeName !== "A" && type !== "reset";
        })
        .slice(0, 6)
        .map((button) =>
            [
                button.textContent ?? "",
                button.getAttribute("value") ?? "",
                button.getAttribute("aria-label") ?? ""
            ].join(" ")
        );
    return [...buttons, form.id, form.getAttribute("name") ?? "", form.getAttribute("action") ?? ""]
        .join(" ")
        .replace(/\s+/g, " ")
        .toLowerCase();
}

/** Whether a box is on screen and can be typed into right now. */
function usable(field: HTMLInputElement): boolean {
    const box = field.getBoundingClientRect();
    const view = field.ownerDocument.defaultView ?? window;
    return (
        !field.disabled &&
        !field.readOnly &&
        field.getAttribute("aria-hidden") !== "true" &&
        box.width >= 2 &&
        box.height >= 2 &&
        // Parked off the page, which is a step the site has not shown yet.
        box.right + view.scrollX > 0 &&
        box.bottom + view.scrollY > 0 &&
        view.getComputedStyle(field).visibility !== "hidden"
    );
}

/** One input, as the rules read it. Everything the DOM knows, flattened. */
export function describeInput(field: HTMLInputElement): FieldFacts {
    return {
        type: (field.type || "text").toLowerCase(),
        autocomplete: (field.getAttribute("autocomplete") ?? "").toLowerCase(),
        words: [
            field.name,
            field.id,
            field.placeholder,
            field.title,
            field.getAttribute("aria-label") ?? "",
            labelledBy(field),
            ...[...(field.labels ?? [])].map((label) => label.textContent ?? "")
        ]
            .join(" ")
            // `login_code` and `loginCode` are two words, and the rules match
            // words: `\bcode\b` never matches either as written.
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/_/g, " ")
            .toLowerCase(),
        // The DOM answers -1 for a box with no limit.
        maxLength: field.maxLength > 0 ? field.maxLength : null,
        inputMode: (field.inputMode || "").toLowerCase(),
        usable: usable(field),
        // The form as the page wrote it: boxes with none are grouped by the
        // rules' own fallbacks, and the panel only feeds `formWords`.
        form: field.form ?? null,
        formWords: formWords(field)
    };
}
