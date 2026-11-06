// @vitest-environment jsdom

/**
 * A chat lock code of a known length opens on its last digit.
 *
 * The code is 4, 6 or 8 digits, chosen when it is set, so the box knows when it
 * is whole and submits by itself - once, not again on every render. A code set
 * before the length was recorded keeps its button.
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodeInput, codeDigits, justCompleted } from "@/components/code-input";

vi.mock("@/app/(app)/chat/lock-actions", () => ({}));
vi.mock("@/components/step-up-dialog", () => ({ StepUpDialog: () => null }));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));

import { codeReady } from "@/app/(app)/chat/lock-dialogs";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function Form({ length, onSubmit }: { length: number; onSubmit: (code: string) => void }) {
    const [code, setCode] = useState("");
    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                onSubmit(code);
            }}
        >
            <CodeInput
                aria-label="code"
                masked
                autoSubmit
                length={length}
                value={code}
                onValueChange={setCode}
            />
        </form>
    );
}

describe("a chat lock code box", () => {
    it.each([4, 6, 8])("submits a %i-digit code once, on the last digit", (length) => {
        vi.useFakeTimers();
        const onSubmit = vi.fn();
        render(<Form length={length} onSubmit={onSubmit} />);
        const box = screen.getByLabelText("code");
        const whole = "1234567890".slice(0, length);
        for (let typed = 1; typed < length; typed++)
            fireEvent.change(box, { target: { value: whole.slice(0, typed) } });
        vi.runAllTimers();
        expect(onSubmit).not.toHaveBeenCalled();
        fireEvent.change(box, { target: { value: whole } });
        vi.runAllTimers();
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith(whole);
        // A digit past the end changes nothing and sends nothing more.
        fireEvent.change(box, { target: { value: `${whole}9` } });
        vi.runAllTimers();
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("is masked and keeps only the code's digits", () => {
        render(<Form length={4} onSubmit={() => undefined} />);
        const box = screen.getByLabelText("code") as HTMLInputElement;
        expect(box.type).toBe("password");
        fireEvent.change(box, { target: { value: "1a2-3 4 5" } });
        expect(box.value).toBe("1234");
    });

    it("completes only on the keystroke that makes it whole", () => {
        expect(justCompleted("123", "1234", 4)).toBe(true);
        expect(justCompleted("1234", "1234", 4)).toBe(false);
        expect(justCompleted("12345", "123456", 8)).toBe(false);
        expect(codeDigits("123456789", 8)).toBe("12345678");
    });

    it("waits for a button when the length is not known", () => {
        expect(codeReady("1234", 4)).toBe(true);
        expect(codeReady("123", 4)).toBe(false);
        expect(codeReady("12345", 6)).toBe(false);
        // An older code of any shape within the bounds.
        expect(codeReady("hunter2", null)).toBe(true);
        expect(codeReady("abc", null)).toBe(false);
    });
});
