/**
 * One box per digit for a code typed on the app's own pages, drawn over the one
 * real input the page already has - the dashboard's code boxes, with the same
 * caret rules (`dashboard/packages/ui/src/components/code-boxes.ts`), for a page
 * without React.
 *
 * The input stays a plain text field under the boxes, so paste, autofill and a
 * screen reader meet an ordinary input with its label: a digit replaces the box
 * it is typed into, Backspace walks back, the arrows, Home and End move between
 * boxes, a click lands on the box under it, and a paste fills every box.
 */

import {
    codeDigits,
    pasteInto,
    settleSelection,
    sharedStart,
    slotAt,
    type CodeSelection
} from "../../../../dashboard/packages/ui/src/components/code-boxes";

export interface CodeBoxes {
    /** Redraw after the page changed the input itself: its value or `disabled`. */
    refresh(): void;
}

/** Draw `length` boxes over `input`, which keeps its id, label and listeners. */
export function codeBoxes(input: HTMLInputElement, length: number): CodeBoxes {
    const row = document.createElement("div");
    row.className = "code-boxes";
    row.dir = "ltr";
    input.replaceWith(row);
    // The browser would cut a paste of "123 456" to "123 45" before anything saw it.
    input.removeAttribute("maxlength");
    const cells = Array.from({ length }, () => {
        const cell = document.createElement("span");
        cell.className = "code-box";
        cell.setAttribute("aria-hidden", "true");
        row.append(cell);
        return cell;
    });
    row.append(input);

    let code = codeDigits(input.value, length);
    let focused = false;
    // A caret left by a deletion inside the code stays bare, so the next digit
    // goes back where the deleted one was.
    let inserting = false;
    let selection: CodeSelection = [0, 0];

    function draw(): void {
        const [from, to] = selection;
        cells.forEach((cell, index) => {
            const active = focused && (to - from > 1 ? index >= from && index < to : index === from);
            cell.textContent = code[index] ?? "";
            cell.toggleAttribute("data-active", active);
            cell.toggleAttribute("data-filled", Boolean(code[index]));
            if (focused && from === to && index === from) {
                const caret = document.createElement("span");
                caret.className = "code-caret";
                cell.append(caret);
            }
        });
        row.classList.toggle("disabled", input.disabled);
    }

    /** Put the selection where it belongs for `filled` digits, now and again
     *  after the browser settles - a refused character drops the caret at the end. */
    function place(start: number, end: number, filled: number): void {
        const [from, to] = settleSelection(start, end, filled, length, inserting);
        selection = [from, to];
        const apply = () => {
            if (document.activeElement !== input) return;
            if (input.selectionStart !== from || input.selectionEnd !== to) input.setSelectionRange(from, to);
        };
        apply();
        queueMicrotask(apply);
        draw();
    }

    /** Take `next` as the code, tell the page's own listeners when it changed. */
    function commit(next: string, caret: number): void {
        const changed = next !== code;
        code = next;
        if (input.value !== next) input.value = next;
        place(caret, caret, next.length);
        if (changed) input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function fromSelection(): void {
        const start = input.selectionStart ?? code.length;
        place(start, input.selectionEnd ?? start, code.length);
    }

    input.addEventListener("focus", () => {
        focused = true;
        inserting = false;
        place(code.length, code.length, code.length);
    });
    input.addEventListener("blur", () => {
        focused = false;
        inserting = false;
        draw();
    });
    for (const name of ["select", "keyup", "mouseup"]) input.addEventListener(name, fromSelection);
    input.addEventListener("click", (event) => {
        const spans = cells.map((cell) => {
            const box = cell.getBoundingClientRect();
            return [box.left, box.right] as const;
        });
        const at = slotAt(event.clientX, spans);
        inserting = false;
        place(at, at, code.length);
    });
    input.addEventListener("keydown", (event) => {
        const { key } = event;
        const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
        // A letter or a space never lands, so the caret never moves for it.
        if (plain && key.length === 1 && !/\d/.test(key)) {
            event.preventDefault();
            return;
        }
        if (!plain || event.shiftKey) return;
        const [from, to] = selection;
        const last = Math.min(code.length, length - 1);
        const target =
            key === "ArrowLeft" ? (to - from > 1 ? from : from - 1)
                : key === "ArrowRight" ? (to - from > 1 ? to - 1 : from + 1)
                    : key === "Home" || key === "ArrowUp" ? 0
                        : key === "End" || key === "ArrowDown" ? last
                            : null;
        if (target === null) return;
        event.preventDefault();
        inserting = false;
        const at = Math.max(0, Math.min(target, last));
        place(at, at, code.length);
    });
    input.addEventListener("paste", (event) => {
        if (input.readOnly || input.disabled) return;
        event.preventDefault();
        const [from, to] = selection;
        const text = event.clipboardData?.getData("text") ?? "";
        const pasted = pasteInto(code, input.selectionStart ?? from, input.selectionEnd ?? to, text, length);
        if (!pasted) return;
        inserting = false;
        commit(pasted.value, pasted.caret);
    });
    // Registered before the page's own listener, so that one reads the code already cleaned.
    input.addEventListener("input", (event) => {
        if (!event.isTrusted) return;
        const raw = input.value;
        const caret = input.selectionStart ?? raw.length;
        if (raw.replace(/\D/g, "").length <= length) {
            // Typing, deleting, select-all and type, a code autofilled into the empty boxes.
            const next = codeDigits(raw, length);
            const at = codeDigits(raw.slice(0, caret), length).length;
            inserting = next.length < code.length && at < next.length;
            code = next;
            if (input.value !== next) input.value = next;
            place(at, at, next.length);
            return;
        }
        // More digits than the code holds: something was dropped in over what was
        // there (an autofill, a paste the keyboard inserted itself).
        const tail = raw.length - caret;
        const start = sharedStart(raw.slice(0, caret), code);
        const end = Math.max(start, code.length - tail);
        const pasted = pasteInto(code, start, end, raw.slice(start, caret), length);
        inserting = false;
        if (pasted) {
            code = pasted.value;
            input.value = pasted.value;
            place(pasted.caret, pasted.caret, pasted.value.length);
        } else {
            input.value = code;
            place(caret, caret, code.length);
        }
    });

    draw();
    return {
        refresh() {
            const next = codeDigits(input.value, length);
            if (next !== code) {
                code = next;
                inserting = false;
                if (focused) place(next.length, next.length, next.length);
            }
            if (input.value !== next) input.value = next;
            draw();
        }
    };
}
