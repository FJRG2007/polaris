/**
 * The login offered on the page itself, rather than from the toolbar.
 *
 * An unlisted script, deliberately: a content script declared in the manifest
 * carries its `matches` into `host_permissions`, and the browser then tells
 * everybody who installs this that it may read every page they open. That is the
 * access this extension has always refused to ask for. This file is built as a
 * standalone bundle with no manifest entry at all, and the worker registers it at
 * runtime for the origins somebody has actually granted - so the promise made at
 * install time is the same one as before, and inline filling appears only where
 * it was asked for.
 *
 * What it does is deliberately small. It finds the login boxes, marks them, and
 * offers what the vault has for this page. Choosing one sends the same `fill`
 * message the popup sends, so the two strings reach the page exactly where they
 * always did and no new path carries a password. This script never sees one: it
 * asks for names and gets names.
 *
 * It draws inside a closed shadow root because the alternative is a menu wearing
 * whatever CSS the page happens to have - and a login chooser that a page can
 * restyle is a login chooser a page can disguise.
 */

import { findFields, type FieldFacts } from "@/lib/fields";
import { askBackground, type ItemSummary } from "@/lib/messages";

/** How long to wait for a page to stop changing before looking again. Logins
 *  arrive late on most sites now - a form is rendered after the framework has
 *  fetched something - so one look at load would miss them. */
const SETTLE_MS = 400;

/** The mark's size, and the room it needs at the right edge of a field. */
const MARK = 18;

export default defineUnlistedScript({
    main() {
        // Never in a frame that is not the page: an advert's iframe has inputs
        // too, and offering somebody's password inside one is the whole shape of
        // a clickjacking.
        if (window.top !== window) return;
        void start();
    }
});

async function start(): Promise<void> {
    // Two questions the page must not decide: whether this site was switched
    // off, and whether there is an open vault to offer anything from. Both are
    // the worker's, and both are re-asked whenever the menu opens rather than
    // cached here - a vault that locks while a tab sits open must stop offering.
    const here = await askBackground({ kind: "blocked" });
    if (!here.ok || !("blocked" in here) || here.blocked) return;

    let host: HTMLElement | null = null;
    let open = false;

    const boxes = (): { user: HTMLInputElement | null; pass: HTMLInputElement | null } => {
        const inputs = [...document.querySelectorAll("input")];
        const found = findFields(inputs.map(describe));
        return {
            user: found.username === null ? null : (inputs[found.username] ?? null),
            pass: found.password === null ? null : (inputs[found.password] ?? null)
        };
    };

    /** The field the mark sits on: the name where there is one, the password
     *  otherwise, because that is where somebody's eye already is. */
    const anchor = (): HTMLInputElement | null => {
        const { user, pass } = boxes();
        return user ?? pass;
    };

    const place = (): void => {
        const field = anchor();
        if (!field) {
            host?.remove();
            host = null;
            return;
        }
        if (!host) host = mark(() => void show(field));
        const box = field.getBoundingClientRect();
        // Fixed rather than absolute: a field inside a scrolling panel moves
        // without the document scrolling, and `position: absolute` would leave
        // the mark behind on the page.
        host.style.top = `${box.top + (box.height - MARK) / 2}px`;
        host.style.left = `${box.right - MARK - 6}px`;
        host.style.display = box.width < 60 || box.height < 16 ? "none" : "block";
    };

    const show = async (field: HTMLInputElement): Promise<void> => {
        if (open) return;
        open = true;
        try {
            const reply = await askBackground({ kind: "itemsFor", url: location.href });
            const items = reply.ok && "items" in reply ? reply.items : [];
            menu(field, items, async (item) => {
                await askBackground({ kind: "fill", id: item.id });
            });
        } finally {
            open = false;
        }
    };

    place();
    // The page keeps moving: a field can be replaced, revealed, or scrolled.
    // One debounced look rather than one per mutation, because a login page
    // renders hundreds of them in a burst.
    let settling: number | null = null;
    const again = (): void => {
        if (settling !== null) window.clearTimeout(settling);
        settling = window.setTimeout(place, SETTLE_MS);
    };
    new MutationObserver(again).observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    window.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place, { passive: true });
}

/** One input, as the rules read it. Everything the DOM knows, flattened. */
function describe(field: HTMLInputElement): FieldFacts {
    const box = field.getBoundingClientRect();
    return {
        type: (field.type || "text").toLowerCase(),
        autocomplete: (field.autocomplete || "").toLowerCase(),
        words: [
            field.name,
            field.id,
            field.placeholder,
            field.title,
            field.getAttribute("aria-label") ?? "",
            field.labels?.[0]?.textContent ?? ""
        ]
            .join(" ")
            .toLowerCase(),
        usable:
            !field.disabled &&
            !field.readOnly &&
            box.width >= 2 &&
            box.height >= 2 &&
            getComputedStyle(field).visibility !== "hidden",
        form: field.form
    };
}

/** The mark that sits in the corner of a login box. */
function mark(onPress: () => void): HTMLElement {
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;z-index:2147483646;width:${MARK}px;height:${MARK}px;`;
    const shadow = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.type = "button";
    button.title = "Fill from Polaris";
    button.setAttribute("aria-label", "Fill from Polaris");
    button.textContent = "P";
    button.style.cssText = `
        width: ${MARK}px;
        height: ${MARK}px;
        border: 0;
        border-radius: 5px;
        cursor: pointer;
        font: 600 11px ui-sans-serif, system-ui, sans-serif;
        color: #fff;
        background: hsl(258 82% 62%);
    `;
    button.addEventListener("mousedown", (event) => {
        // The field must not lose focus to the mark: a page that fills on blur
        // would act on an empty box.
        event.preventDefault();
        onPress();
    });
    shadow.append(button);
    document.body.append(host);
    return host;
}

/** The chooser, under the field, in a shadow root of its own. */
function menu(
    field: HTMLInputElement,
    items: readonly ItemSummary[],
    onChoose: (item: ItemSummary) => Promise<void>
): void {
    const host = document.createElement("div");
    const box = field.getBoundingClientRect();
    host.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        top: ${box.bottom + 4}px;
        left: ${box.left}px;
        width: ${Math.max(220, Math.min(320, box.width))}px;
    `;
    const shadow = host.attachShadow({ mode: "closed" });

    const panel = document.createElement("div");
    panel.style.cssText = `
        border: 1px solid hsl(225 10% 16%);
        border-radius: 8px;
        overflow: hidden;
        background: hsl(225 11% 9%);
        color: hsl(220 14% 96%);
        font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
        box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
    `;

    const close = (): void => {
        host.remove();
        document.removeEventListener("mousedown", away, true);
        document.removeEventListener("keydown", onKey, true);
    };
    const away = (event: Event): void => {
        if (!host.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") close();
    };

    if (items.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "Nothing saved for this site.";
        empty.style.cssText = "margin:0;padding:10px 12px;color:hsl(222 10% 66%);";
        panel.append(empty);
    } else {
        for (const item of items) {
            const row = document.createElement("button");
            row.type = "button";
            row.style.cssText = `
                display: block;
                width: 100%;
                border: 0;
                background: transparent;
                color: inherit;
                font: inherit;
                text-align: left;
                padding: 8px 12px;
                cursor: pointer;
            `;
            const name = document.createElement("span");
            name.textContent = item.name;
            name.style.cssText = "display:block;";
            const who = document.createElement("span");
            who.textContent = [item.username, item.vault].filter(Boolean).join(" - ");
            who.style.cssText = "display:block;font-size:12px;color:hsl(222 10% 66%);";
            row.append(name, who);
            row.addEventListener("mouseenter", () => {
                row.style.background = "hsl(225 12% 13%)";
            });
            row.addEventListener("mouseleave", () => {
                row.style.background = "transparent";
            });
            row.addEventListener("mousedown", (event) => {
                event.preventDefault();
                close();
                void onChoose(item);
            });
            panel.append(row);
        }
    }

    shadow.append(panel);
    document.body.append(host);
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", onKey, true);
}
