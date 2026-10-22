/**
 * What Polar sees of a page in the person's browser, and the two things it may
 * do there: click an element and type into a box.
 *
 * Runs inside the page (`entrypoints/polar-agent.ts`), in the extension's own
 * isolated world. Elements are handed out as refs (`e12`) from a snapshot of
 * the page's links, buttons and boxes, the way Playwright MCP's accessibility
 * snapshot names them, so an action names something Polar was shown rather
 * than a selector it guessed. The refs live in this script's memory only; no
 * attribute is written into the page.
 *
 * What never leaves the page: a password box's value (a read and a snapshot
 * show that the box is there, never what is in it), and anything the page keeps
 * in cookies or storage - nothing here reads either. Typing into a password box
 * is refused outright: a password is typed by the person, or filled from their
 * vault, never by an assistant.
 *
 * Pure DOM: everything takes the document, so the tests run it on jsdom.
 */

import {
    BROWSER_ELEMENTS_MOST,
    BROWSER_TEXT_MOST,
    type BrowserElement
} from "@polaris/core/browser-agent";

const INTERACTIVE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [contenteditable=""], [contenteditable="true"]';

const SKIPPED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME"]);

/** The refs handed out on this page, most recent snapshot first. */
export class RefTable {
    private next = 1;
    private readonly byRef = new Map<string, Element>();
    private readonly byElement = new WeakMap<Element, string>();

    refOf(element: Element): string {
        const known = this.byElement.get(element);
        if (known && this.byRef.get(known) === element) return known;
        const ref = `e${this.next++}`;
        this.byRef.set(ref, element);
        this.byElement.set(element, ref);
        return ref;
    }

    /** The element a ref names, while it is still on the page. */
    lookup(ref: string): Element | null {
        const element = this.byRef.get(ref);
        if (!element || !element.isConnected) return null;
        return element;
    }
}

/** Whether a box holds a password, however the page marked it. */
export function isPasswordBox(element: Element): boolean {
    if (element.tagName !== "INPUT") return false;
    const input = element as HTMLInputElement;
    if ((input.getAttribute("type") ?? "").toLowerCase() === "password") return true;
    const auto = (input.getAttribute("autocomplete") ?? "").toLowerCase();
    return auto.includes("current-password") || auto.includes("new-password");
}

function hidden(element: Element): boolean {
    if ((element as HTMLElement).hidden) return true;
    if (element.getAttribute("aria-hidden") === "true") return true;
    const view = element.ownerDocument.defaultView;
    const style = view?.getComputedStyle(element);
    return style?.display === "none" || style?.visibility === "hidden";
}

function clean(text: string, most: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > most ? `${flat.slice(0, most - 3)}...` : flat;
}

/** The role a reader would announce for an element. */
function roleOf(element: Element): string {
    const role = element.getAttribute("role");
    if (role) return role;
    const tag = element.tagName;
    if (tag === "A") return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
        const type = ((element as HTMLInputElement).type || "text").toLowerCase();
        if (type === "checkbox" || type === "radio") return type;
        if (type === "submit" || type === "button" || type === "reset") return "button";
        if (type === "search") return "searchbox";
        return "textbox";
    }
    return "textbox";
}

/** The name a reader would announce: label, aria, text, then placeholder. */
function nameOf(element: Element): string {
    const doc = element.ownerDocument;
    const aria = element.getAttribute("aria-label");
    if (aria) return clean(aria, 200);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
        const text = labelledBy
            .split(/\s+/)
            .map((id) => doc.getElementById(id)?.textContent ?? "")
            .join(" ");
        if (text.trim()) return clean(text, 200);
    }
    const id = element.getAttribute("id");
    if (id) {
        const label = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label?.textContent?.trim()) return clean(label.textContent, 200);
    }
    const wrapping = element.closest("label");
    if (wrapping?.textContent?.trim() && element.tagName === "INPUT") {
        return clean(wrapping.textContent, 200);
    }
    if (element.tagName === "INPUT") {
        const input = element as HTMLInputElement;
        if (["submit", "button", "reset"].includes(input.type) && input.value) {
            return clean(input.value, 200);
        }
    }
    const text = element.textContent ?? "";
    if (text.trim()) return clean(text, 200);
    return clean(
        element.getAttribute("placeholder") ??
            element.getAttribute("title") ??
            element.getAttribute("alt") ??
            "",
        200
    );
}

/** One element as the snapshot lists it. A password box never carries a value. */
function describe(element: Element, refs: RefTable): BrowserElement {
    const entry: BrowserElement = {
        ref: refs.refOf(element),
        role: roleOf(element),
        name: nameOf(element)
    };
    if (isPasswordBox(element)) return { ...entry, password: true };
    if (element.tagName === "A") {
        const href = (element as HTMLAnchorElement).href;
        if (href && /^https?:/i.test(href)) return { ...entry, href: href.slice(0, 2048) };
    }
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        const value = (element as HTMLInputElement).value;
        const type = (element as HTMLInputElement).type;
        if (value && type !== "checkbox" && type !== "radio") {
            return { ...entry, value: clean(value, 200) };
        }
    }
    return entry;
}

/** The page's links, buttons and boxes, each with a ref. `query` narrows by name. */
export function snapshot(doc: Document, refs: RefTable, query?: string): BrowserElement[] {
    const wanted = query?.trim().toLowerCase() ?? "";
    const found: BrowserElement[] = [];
    for (const element of doc.querySelectorAll(INTERACTIVE)) {
        if (found.length >= BROWSER_ELEMENTS_MOST) break;
        if (hidden(element)) continue;
        const entry = describe(element, refs);
        if (wanted && !`${entry.name} ${entry.href ?? ""}`.toLowerCase().includes(wanted)) continue;
        found.push(entry);
    }
    return found;
}

/**
 * The page's text as Markdown-like lines: headings, paragraphs, list items,
 * code and links, without scripts, styles or anything hidden. A password box
 * reads as "[password box]", never its value. Capped at `BROWSER_TEXT_MOST`.
 */
export function readText(
    doc: Document,
    selector?: string
): { text: string; truncated: boolean } | null {
    let root: Element | null = doc.body;
    if (selector) {
        try {
            root = doc.querySelector(selector);
        } catch {
            return null;
        }
    }
    if (!root) return null;
    const out: string[] = [];
    let size = 0;
    let truncated = false;
    const push = (line: string) => {
        if (truncated) return;
        if (size + line.length > BROWSER_TEXT_MOST) {
            out.push(line.slice(0, Math.max(0, BROWSER_TEXT_MOST - size)));
            truncated = true;
            return;
        }
        out.push(line);
        size += line.length + 1;
    };
    const inline = (element: Element): string => {
        let text = "";
        for (const node of element.childNodes) {
            if (node.nodeType === 3) text += node.textContent ?? "";
            else if (node.nodeType === 1) {
                const child = node as Element;
                if (SKIPPED.has(child.tagName) || hidden(child)) continue;
                if (child.tagName === "INPUT") {
                    text += isPasswordBox(child) ? " [password box] " : "";
                    continue;
                }
                if (child.tagName === "A") {
                    const href = (child as HTMLAnchorElement).href;
                    const label = clean(inline(child), 300);
                    text +=
                        href && /^https?:/i.test(href) && label
                            ? ` [${label}](${href}) `
                            : ` ${label} `;
                    continue;
                }
                if (child.tagName === "BR") text += "\n";
                else text += inline(child);
            }
        }
        return text;
    };
    const walk = (element: Element) => {
        if (truncated) return;
        if (SKIPPED.has(element.tagName) || hidden(element)) return;
        const tag = element.tagName;
        const heading = /^H([1-6])$/.exec(tag);
        if (heading) {
            const text = clean(inline(element), 300);
            if (text) push(`${"#".repeat(Number(heading[1]))} ${text}`);
            return;
        }
        if (tag === "PRE") {
            const code = (element.textContent ?? "").replace(/\s+$/, "");
            if (code) push(`\`\`\`\n${code}\n\`\`\``);
            return;
        }
        if (tag === "LI") {
            const text = clean(inline(element), BROWSER_TEXT_MOST + 1);
            if (text) push(`- ${text}`);
            return;
        }
        if (
            tag === "P" ||
            tag === "TD" ||
            tag === "TH" ||
            tag === "DT" ||
            tag === "DD" ||
            tag === "BLOCKQUOTE"
        ) {
            const text = clean(inline(element), BROWSER_TEXT_MOST + 1);
            if (text) push(text);
            return;
        }
        if (tag === "INPUT" && isPasswordBox(element)) {
            push("[password box]");
            return;
        }
        // A block that holds only text and inline elements reads as one line.
        const blocks = [...element.children].some((child) =>
            /^(DIV|SECTION|ARTICLE|MAIN|NAV|ASIDE|HEADER|FOOTER|UL|OL|TABLE|TBODY|THEAD|TR|P|PRE|H[1-6]|LI|FORM|DL)$/.test(
                child.tagName
            )
        );
        if (!blocks) {
            const text = clean(inline(element), BROWSER_TEXT_MOST + 1);
            if (text) push(text);
            return;
        }
        for (const child of element.children) walk(child);
    };
    walk(root);
    return { text: out.join("\n"), truncated };
}

/** What a click or a type came to, before it is a protocol answer. */
export type ActOutcome =
    { ok: true } | { ok: false; refusal: "unknown-ref" | "password-field" | "failed" };

/** Click the element a ref names. */
export function clickRef(refs: RefTable, ref: string): ActOutcome {
    const element = refs.lookup(ref);
    if (!element) return { ok: false, refusal: "unknown-ref" };
    (element as HTMLElement).scrollIntoView?.({ block: "center" });
    (element as HTMLElement).click();
    return { ok: true };
}

/** Type into the box a ref names, the way a person would: focus, value, events. */
export function typeRef(refs: RefTable, ref: string, text: string, submit = false): ActOutcome {
    const element = refs.lookup(ref);
    if (!element) return { ok: false, refusal: "unknown-ref" };
    if (isPasswordBox(element)) return { ok: false, refusal: "password-field" };
    const box = element as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
    box.focus();
    if (
        box instanceof element.ownerDocument.defaultView!.HTMLInputElement ||
        box instanceof element.ownerDocument.defaultView!.HTMLTextAreaElement
    ) {
        // The native setter, so a framework that watches the value sees it change.
        const proto = Object.getPrototypeOf(box) as object;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(box, text);
        else box.value = text;
    } else if ((box as HTMLElement).isContentEditable) {
        (box as HTMLElement).textContent = text;
    } else {
        return { ok: false, refusal: "failed" };
    }
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
    if (submit) {
        // The form's own submit where there is one; otherwise Enter, which is
        // what a search box without a form listens for. Never both.
        const form = (box as HTMLInputElement).form;
        if (form?.requestSubmit) form.requestSubmit();
        else {
            const init = { key: "Enter", code: "Enter", bubbles: true };
            box.dispatchEvent(new KeyboardEvent("keydown", init));
            box.dispatchEvent(new KeyboardEvent("keyup", init));
        }
    }
    return { ok: true };
}
