/**
 * The app's own dropdown, in place of a native `<select>`: the browser's
 * select draws the operating system's menu, which looks like no part of
 * Polaris. This one is drawn as the dashboard's `Select` (@polaris/ui) is - a
 * bordered trigger with a chevron, a floating list on the surface colour with
 * a check on the chosen row - and behaves as it does: arrows, Home/End,
 * Enter/Space, Escape, a typed letter jumps, a click outside closes.
 *
 * The list is put on `document.body` and placed with fixed coordinates, below
 * the trigger or above it when there is more room there, as tall as the room
 * allows and scrolling past that, so no ancestor's overflow can cut it.
 *
 * `test/renderer/native-controls.test.ts` fails on a native `<select>` in any
 * page, naming this.
 */

export interface PickerOption {
    readonly value: string;
    readonly label: string;
}

export interface Picker {
    value: string;
    disabled: boolean;
    /** The trigger, for focus checks and labels. */
    readonly element: HTMLButtonElement;
}

const CHEVRON =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

let pickers = 0;

/**
 * Turn `host` (an empty element in the page) into a dropdown of `options`.
 * `onChange` runs when somebody picks a different value, not when code sets one.
 */
export function picker(host: HTMLElement, options: readonly PickerOption[], onChange: (value: string) => void): Picker {
    const id = `picker-${(pickers += 1)}`;
    let current = options[0]?.value ?? "";
    let active = 0;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "picker-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", `${id}-list`);
    const label = host.getAttribute("aria-label");
    if (label) trigger.setAttribute("aria-label", label);
    const shown = document.createElement("span");
    shown.className = "picker-value";
    trigger.append(shown);
    trigger.insertAdjacentHTML("beforeend", CHEVRON);
    host.replaceChildren(trigger);
    host.classList.add("picker");

    const list = document.createElement("ul");
    list.id = `${id}-list`;
    list.className = "picker-list";
    list.setAttribute("role", "listbox");
    list.tabIndex = -1;
    list.hidden = true;
    if (label) list.setAttribute("aria-label", label);
    const rows = options.map((option, index) => {
        const row = document.createElement("li");
        row.id = `${id}-${index}`;
        row.setAttribute("role", "option");
        row.dataset.value = option.value;
        const text = document.createElement("span");
        text.textContent = option.label;
        text.title = option.label;
        row.append(text);
        row.insertAdjacentHTML("beforeend", CHECK);
        row.addEventListener("pointermove", () => highlight(index));
        row.addEventListener("click", () => choose(index));
        list.append(row);
        return row;
    });
    document.body.append(list);

    function draw(): void {
        const index = Math.max(0, options.findIndex((option) => option.value === current));
        shown.textContent = options[index]?.label ?? "";
        shown.title = shown.textContent;
        rows.forEach((row, at) => row.setAttribute("aria-selected", String(at === index)));
    }

    function highlight(index: number): void {
        active = Math.min(Math.max(index, 0), rows.length - 1);
        rows.forEach((row, at) => row.toggleAttribute("data-active", at === active));
        list.setAttribute("aria-activedescendant", rows[active]?.id ?? "");
        rows[active]?.scrollIntoView({ block: "nearest" });
    }

    function place(): void {
        const box = trigger.getBoundingClientRect();
        const gap = 4;
        const margin = 8;
        const below = window.innerHeight - box.bottom - gap - margin;
        const above = box.top - gap - margin;
        list.style.minWidth = `${box.width}px`;
        list.style.maxWidth = `${Math.max(box.width, window.innerWidth - margin * 2)}px`;
        const natural = list.scrollHeight;
        const up = natural > below && above > below;
        list.style.maxHeight = `${Math.max(80, up ? above : below)}px`;
        const width = list.offsetWidth;
        list.style.left = `${Math.min(Math.max(margin, box.left), window.innerWidth - width - margin)}px`;
        list.style.top = up ? `${Math.max(margin, box.top - gap - Math.min(natural, above))}px` : `${box.bottom + gap}px`;
    }

    function open(): void {
        if (trigger.disabled || !list.hidden) return;
        list.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        place();
        highlight(Math.max(0, options.findIndex((option) => option.value === current)));
        list.focus();
        document.addEventListener("pointerdown", outside, true);
        window.addEventListener("resize", close);
        window.addEventListener("blur", close);
    }

    function close(): void {
        if (list.hidden) return;
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        document.removeEventListener("pointerdown", outside, true);
        window.removeEventListener("resize", close);
        window.removeEventListener("blur", close);
    }

    function outside(event: Event): void {
        const target = event.target as Node | null;
        if (target && (list.contains(target) || trigger.contains(target))) return;
        close();
    }

    function choose(index: number): void {
        const option = options[index];
        close();
        trigger.focus();
        if (!option || option.value === current) return;
        current = option.value;
        draw();
        onChange(current);
    }

    trigger.addEventListener("click", () => (list.hidden ? open() : close()));
    trigger.addEventListener("keydown", (event) => {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            open();
        }
    });
    list.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") highlight(active + 1);
        else if (event.key === "ArrowUp") highlight(active - 1);
        else if (event.key === "Home") highlight(0);
        else if (event.key === "End") highlight(rows.length - 1);
        else if (event.key === "Enter" || event.key === " ") choose(active);
        else if (event.key === "Escape") {
            close();
            trigger.focus();
        } else if (event.key === "Tab") close();
        else if (event.key.length === 1) {
            // A typed letter jumps to the next option that starts with it.
            const letter = event.key.toLowerCase();
            const order = [...options.keys()].map((at) => (active + 1 + at) % options.length);
            const found = order.find((at) => options[at]!.label.toLowerCase().startsWith(letter));
            if (found !== undefined) highlight(found);
            return;
        } else return;
        event.preventDefault();
    });

    draw();
    return {
        get value() {
            return current;
        },
        set value(next: string) {
            if (!options.some((option) => option.value === next)) return;
            current = next;
            draw();
        },
        get disabled() {
            return trigger.disabled;
        },
        set disabled(yes: boolean) {
            trigger.disabled = yes;
            if (yes) close();
        },
        element: trigger
    };
}
