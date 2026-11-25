// @vitest-environment jsdom

/**
 * The code boxes, used the way somebody fixing a mistyped code uses them: one
 * box per digit, drawn over one real input, where a wrong digit in the middle is
 * replaced in place, Backspace walks back, and a paste fills every box.
 */

import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { CodeInput } from "@/components/code-input";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

/** A box with its own state, inside a form that records each submit. */
function Harness({
    length = 6,
    initial = "",
    masked = false,
    autoSubmit = false,
    disabled = false,
    invalid = false,
    onSubmit = () => undefined,
    onChange = () => undefined
}: {
    length?: number;
    initial?: string;
    masked?: boolean;
    autoSubmit?: boolean;
    disabled?: boolean;
    invalid?: boolean;
    onSubmit?: (code: string) => void;
    onChange?: (code: string) => void;
}) {
    const [code, setCode] = useState(initial);
    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                onSubmit(code);
            }}
        >
            <CodeInput
                aria-label="code"
                length={length}
                masked={masked}
                autoSubmit={autoSubmit}
                disabled={disabled}
                aria-invalid={invalid || undefined}
                value={code}
                onValueChange={(next) => {
                    setCode(next);
                    onChange(next);
                }}
            />
            <button type="button" onClick={() => setCode("")}>
                clear
            </button>
        </form>
    );
}

function box(): HTMLInputElement {
    return screen.getByLabelText("code") as HTMLInputElement;
}

function slots(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-slot]"));
}

/** What the boxes show, a space for an empty one. */
function drawn(): string {
    return slots()
        .map((slot) => slot.textContent || " ")
        .join("");
}

/** Which box is lit. */
function active(): number[] {
    return slots().flatMap((slot, index) => (slot.dataset.active ? [index] : []));
}

/** Lay the boxes out 40px apart, as a browser would, so a click lands on one. */
function layOut(): void {
    slots().forEach((slot, index) => {
        slot.getBoundingClientRect = () =>
            ({ left: index * 40, right: index * 40 + 36, top: 0, bottom: 40, width: 36, height: 40, x: index * 40, y: 0, toJSON: () => ({}) }) as DOMRect;
    });
}

async function clickSlot(user: ReturnType<typeof userEvent.setup>, index: number): Promise<void> {
    await user.pointer({ keys: "[MouseLeft]", target: box(), coords: { clientX: index * 40 + 18 } });
}

describe("the code boxes", () => {
    it("draws one box per digit over a single input, with one tab stop", () => {
        render(<Harness length={6} />);
        expect(slots()).toHaveLength(6);
        expect(document.querySelectorAll("input")).toHaveLength(1);
        const tabbable = Array.from(document.querySelectorAll<HTMLElement>("input, button")).filter(
            (node) => node.tabIndex >= 0 && node.textContent !== "clear"
        );
        expect(tabbable).toEqual([box()]);
        expect(box().getAttribute("autocomplete")).toBe("one-time-code");
        expect(box().getAttribute("inputmode")).toBe("numeric");
    });

    it("fills the boxes in order and lights the next one", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        expect(active()).toEqual([0]);
        await user.keyboard("123");
        expect(drawn()).toBe("123   ");
        expect(active()).toEqual([3]);
    });

    it("refuses a letter or a space without moving the caret", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        await user.keyboard("1a 2");
        expect(drawn()).toBe("12    ");
        expect(onChange.mock.calls.map(([code]) => code)).toEqual(["1", "12"]);
        expect(active()).toEqual([2]);
    });

    it("keeps a caret refused a character on a phone keyboard where it was", async () => {
        render(<Harness initial="1234" />);
        const input = box();
        act(() => input.setSelectionRange(2, 2));
        fireEvent.change(input, { target: { value: "12x34", selectionStart: 3, selectionEnd: 3 } });
        await act(async () => undefined);
        expect(input.value).toBe("1234");
        expect(drawn()).toBe("1234  ");
    });

    it("deletes the last digit with Backspace on the empty box after it, and walks back", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.keyboard("123");
        await user.keyboard("{Backspace}");
        expect(drawn()).toBe("12    ");
        expect(active()).toEqual([2]);
        await user.keyboard("{Backspace}{Backspace}{Backspace}");
        expect(drawn()).toBe("      ");
        expect(active()).toEqual([0]);
        await user.keyboard("7");
        expect(drawn()).toBe("7     ");
    });

    it("replaces a wrong digit in the middle without retyping the rest", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        await user.keyboard("123956");
        layOut();
        await clickSlot(user, 3);
        expect(active()).toEqual([3]);
        await user.keyboard("4");
        expect(drawn()).toBe("123456");
        expect(onChange).toHaveBeenLastCalledWith("123456");
        expect(active()).toEqual([4]);
    });

    it("lets a digit deleted in the middle be typed back in its place", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.keyboard("123956");
        layOut();
        await clickSlot(user, 3);
        await user.keyboard("{Backspace}");
        expect(drawn()).toBe("12356 ");
        await user.keyboard("4");
        expect(drawn()).toBe("123456");
    });

    it("deletes the lit digit with Delete", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.keyboard("1234");
        layOut();
        await clickSlot(user, 1);
        await user.keyboard("{Delete}");
        expect(drawn()).toBe("134   ");
    });

    it("puts a click past the code on the first empty box", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.keyboard("12");
        layOut();
        await clickSlot(user, 5);
        expect(active()).toEqual([2]);
    });

    it("moves with the arrows, Home and End, and stays inside the code", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.keyboard("1234");
        await user.keyboard("{ArrowLeft}{ArrowLeft}");
        expect(active()).toEqual([2]);
        await user.keyboard("9");
        expect(drawn()).toBe("1294  ");
        await user.keyboard("{Home}");
        expect(active()).toEqual([0]);
        await user.keyboard("{ArrowLeft}");
        expect(active()).toEqual([0]);
        await user.keyboard("{End}");
        expect(active()).toEqual([4]);
        await user.keyboard("{ArrowRight}");
        expect(active()).toEqual([4]);
    });

    it("keeps the last box lit on a whole code and replaces it", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.keyboard("1234567");
        expect(drawn()).toBe("123457");
        expect(active()).toEqual([5]);
    });

    it("replaces the whole code on select-all and a digit", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.keyboard("123456");
        await user.keyboard("{Control>}a{/Control}");
        expect(active()).toEqual([0, 1, 2, 3, 4, 5]);
        await user.keyboard("8");
        expect(drawn()).toBe("8     ");
    });

    it("fills every box from a pasted code, wherever the caret is, separators and all", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.keyboard("12");
        await user.paste("987 654");
        expect(drawn()).toBe("987654");
        layOut();
        await clickSlot(user, 2);
        await user.paste("111-222");
        expect(drawn()).toBe("111222");
    });

    it("fills from the caret on with a shorter paste", async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.keyboard("12345");
        layOut();
        await clickSlot(user, 1);
        await user.paste("77");
        expect(drawn()).toBe("17745 ");
        expect(active()).toEqual([3]);
    });

    it("ignores a paste with no digit in it", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        await user.paste("hello");
        expect(drawn()).toBe("      ");
        expect(onChange).not.toHaveBeenCalled();
    });

    it("submits once when typed whole, and not again when a digit is corrected", async () => {
        const user = userEvent.setup();
        const onSubmit = vi.fn();
        render(<Harness autoSubmit onSubmit={onSubmit} />);
        await user.keyboard("12345");
        await act(async () => new Promise((done) => setTimeout(done, 5)));
        expect(onSubmit).not.toHaveBeenCalled();
        await user.keyboard("6");
        await act(async () => new Promise((done) => setTimeout(done, 5)));
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith("123456");
        await user.keyboard("{ArrowLeft}9");
        await act(async () => new Promise((done) => setTimeout(done, 5)));
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("submits once on a pasted or autofilled code", async () => {
        const user = userEvent.setup();
        const onSubmit = vi.fn();
        render(<Harness autoSubmit onSubmit={onSubmit} />);
        await user.paste("246810");
        await act(async () => new Promise((done) => setTimeout(done, 5)));
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith("246810");
        cleanup();
        const filled = vi.fn();
        render(<Harness autoSubmit onSubmit={filled} />);
        fireEvent.change(box(), { target: { value: "135790" } });
        await act(async () => new Promise((done) => setTimeout(done, 5)));
        expect(filled).toHaveBeenCalledTimes(1);
        expect(filled).toHaveBeenCalledWith("135790");
    });

    it("takes a code autofilled over a partial one whole", async () => {
        render(<Harness initial="12" />);
        fireEvent.change(box(), { target: { value: "12654321" } });
        await act(async () => undefined);
        expect(drawn()).toBe("654321");
    });

    it("draws a secret as dots, shows it on the eye, and keeps it a password field", async () => {
        const user = userEvent.setup();
        render(<Harness masked length={4} />);
        await user.keyboard("1234");
        expect(box().type).toBe("password");
        expect(drawn()).toBe("••••");
        await user.click(screen.getByRole("button", { name: /show/i }));
        expect(box().type).toBe("text");
        expect(drawn()).toBe("1234");
        await user.click(screen.getByRole("button", { name: /hide/i }));
        expect(drawn()).toBe("••••");
    });

    it("is disabled and marks every box on an error", () => {
        render(<Harness disabled invalid initial="12" />);
        expect(box().disabled).toBe(true);
        expect(slots().every((slot) => slot.className.includes("border-danger"))).toBe(true);
    });

    it("follows the caller clearing the code", async () => {
        const user = userEvent.setup();
        render(<Harness initial="123456" />);
        await user.click(screen.getByText("clear"));
        expect(drawn()).toBe("      ");
        expect(box().value).toBe("");
    });

    it("draws a long code and stays left to right in a right-to-left page", () => {
        document.documentElement.dir = "rtl";
        render(<Harness length={10} initial="1234567890" />);
        expect(slots()).toHaveLength(10);
        expect(drawn()).toBe("1234567890");
        expect(slots()[0].parentElement?.getAttribute("dir")).toBe("ltr");
        expect(slots().every((slot) => slot.className.includes("min-w-0"))).toBe(true);
        document.documentElement.dir = "";
    });

    it("stays one plain box when the length is not known", () => {
        render(<CodeInput aria-label="code" boxes={false} value="" onValueChange={() => undefined} />);
        expect(slots()).toHaveLength(0);
        expect(box().getAttribute("placeholder")).toMatch(/^\d{6}$/);
    });
});
