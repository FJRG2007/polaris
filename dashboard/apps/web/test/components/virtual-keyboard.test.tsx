// @vitest-environment jsdom

/**
 * The on-screen keyboard types where the caret is, the way a real key does
 * (React's onChange sees it), and Korean jamo compose into syllables.
 */

import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualKeyboard, type KeyboardLayoutId } from "@polaris/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    LAYOUTS,
    backspaceHangul,
    composeHangul,
    deleteBefore,
    insertAt,
    layoutForLanguage
} from "../../../../packages/ui/src/lib/keyboard-layouts";

afterEach(cleanup);

const LABELS = {
    open: "Show the keyboard",
    close: "Hide the keyboard",
    shift: "Shift",
    alt: "Symbols",
    backspace: "Delete",
    space: "Space",
    layout: "Keyboard layout",
    layouts: {
        latin: "Latin",
        cyrillic: "Cyrillic",
        greek: "Greek",
        arabic: "Arabic",
        hebrew: "Hebrew",
        devanagari: "Devanagari",
        kana: "Kana",
        hangul: "Korean"
    }
};

/** Jamo typed one after another, composing as the keyboard does. */
function typeJamo(keys: string): string {
    let text = "";
    for (const key of keys) {
        const before = text.slice(-1);
        text = before ? text.slice(0, -1) + composeHangul(before, key) : key;
    }
    return text;
}

describe("Hangul composition", () => {
    it("builds syllables from lead, vowel and tail", () => {
        expect(typeJamo("ㅎㅏㄴ")).toBe("한");
        expect(typeJamo("ㅎㅏㄴㄱㅡㄹ")).toBe("한글");
    });

    it("moves a tail onto the next syllable when a vowel follows", () => {
        expect(typeJamo("ㄱㅏㄱㅏ")).toBe("가가");
        // A compound tail splits: its second half starts the new syllable.
        expect(typeJamo("ㄱㅏㅂㅅㅏ")).toBe("갑사");
    });

    it("combines compound vowels and tails", () => {
        expect(typeJamo("ㄱㅗㅏ")).toBe("과");
        expect(typeJamo("ㄷㅏㄹㄱ")).toBe("닭");
    });

    it("leaves jamo that do not combine side by side", () => {
        expect(typeJamo("ㅏㅏ")).toBe("ㅏㅏ");
        expect(typeJamo("ㄱㄱ")).toBe("ㄱㄱ");
    });

    it("takes off one jamo at a time on Backspace", () => {
        expect(backspaceHangul("닭")).toBe("달");
        expect(backspaceHangul("달")).toBe("다");
        expect(backspaceHangul("과")).toBe("고");
        expect(backspaceHangul("고")).toBe("ㄱ");
        expect(backspaceHangul("ㄱ")).toBe("");
    });
});

describe("typing at the caret", () => {
    function field(value: string, caret: number, end = caret) {
        const input = document.createElement("textarea");
        input.value = value;
        document.body.append(input);
        input.setSelectionRange(caret, end);
        const seen: string[] = [];
        input.addEventListener("input", () => seen.push(input.value));
        return { input, seen };
    }

    it("inserts at the caret and moves the caret past it, firing input", () => {
        const { input, seen } = field("Hola mundo", 4);
        expect(insertAt(input, "ñ")).toBe(5);
        expect(input.value).toBe("Holañ mundo");
        expect(input.selectionStart).toBe(5);
        expect(seen).toEqual(["Holañ mundo"]);
    });

    it("replaces the selection", () => {
        const { input } = field("abc", 1, 2);
        insertAt(input, "é");
        expect(input.value).toBe("aéc");
    });

    it("deletes a whole emoji before the caret", () => {
        const { input } = field("ok👍🏽", 6);
        deleteBefore(input);
        expect(input.value).toBe("ok");
    });

    it("never passes the field's maxLength", () => {
        const { input } = field("ab", 2);
        input.maxLength = 2;
        expect(insertAt(input, "c")).toBeNull();
        expect(input.value).toBe("ab");
    });
});

function Controlled({ layout: start }: { layout: KeyboardLayoutId }) {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const [text, setText] = useState("");
    const [layout, setLayout] = useState(start);
    return (
        <>
            <textarea
                aria-label="Text"
                ref={ref}
                value={text}
                onChange={(e) => setText(e.target.value)}
            />
            <output>{text}</output>
            <VirtualKeyboard
                target={ref}
                layout={layout}
                onLayoutChange={setLayout}
                labels={LABELS}
            />
        </>
    );
}

describe("the keyboard on a React field", () => {
    it("types into a controlled field and composes Korean", () => {
        render(<Controlled layout="hangul" />);
        fireEvent.click(screen.getByRole("button", { name: "Show the keyboard" }));
        for (const key of ["ㅎ", "ㅏ", "ㄴ"])
            fireEvent.click(screen.getByRole("button", { name: key }));
        expect(screen.getByRole("status").textContent).toBe("한");
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(screen.getByRole("status").textContent).toBe("하");
    });

    it("types Shift's layer for one key, then the base again", () => {
        render(<Controlled layout="cyrillic" />);
        fireEvent.click(screen.getByRole("button", { name: "Show the keyboard" }));
        fireEvent.click(screen.getByRole("button", { name: "Shift" }));
        fireEvent.click(screen.getByRole("button", { name: "П" }));
        fireEvent.click(screen.getByRole("button", { name: "р" }));
        expect(screen.getByRole("status").textContent).toBe("Пр");
    });
});

describe("the layout for a language", () => {
    it("is the script the language is written in", () => {
        expect(layoutForLanguage("ko")).toBe("hangul");
        expect(layoutForLanguage("zh-Hans")).toBe("latin");
        expect(layoutForLanguage("ar")).toBe("arabic");
        expect(layoutForLanguage(null)).toBe("latin");
    });

    it("has a key for every layer of every layout", () => {
        for (const layout of Object.values(LAYOUTS)) {
            for (const layer of [layout.base, layout.shift, layout.alt]) {
                expect(layer.flat().every((key) => key.length > 0)).toBe(true);
            }
        }
    });
});
