import { describe, expect, it } from "vitest";
import * as macs from "./mac-address";

describe("reading a MAC somebody typed", () => {
    it.each([
        ["aabbccddeeff", "AA:BB:CC:DD:EE:FF"],
        ["AABBCCDDEEFF", "AA:BB:CC:DD:EE:FF"],
        ["aa:bb:cc:dd:ee:f0", "AA:BB:CC:DD:EE:F0"],
        ["AA-BB-CC-DD-EE-F0", "AA:BB:CC:DD:EE:F0"],
        ["aabb.ccdd.eef0", "AA:BB:CC:DD:EE:F0"],
        ["  c8:f7:42:1a:2b:3c  ", "C8:F7:42:1A:2B:3C"]
    ])("reads %s as %s", (typed, canonical) => {
        expect(macs.parseMac(typed)).toBe(canonical);
        expect(macs.isMac(typed)).toBe(true);
    });

    it.each([
        ["", "nothing"],
        ["aabbccddee", "too short"],
        ["aabbccddeeff00", "too long"],
        ["aa:bb:cc:dd:ee", "five groups"],
        ["aa:bb-cc:dd:ee:ff", "mixed separators"],
        ["aabb.ccdd.eeff.0011", "too many groups"],
        ["gg:bb:cc:dd:ee:ff", "not hex"],
        ["10.0.1.30", "an IP address"],
        ["fe80::1", "an IPv6 address"],
        ["00:00:00:00:00:00", "the all-zero address"],
        ["ff:ff:ff:ff:ff:ff", "broadcast"],
        ["01:00:5e:00:00:fb", "a multicast group"]
    ])("refuses %s (%s)", (typed) => {
        expect(macs.parseMac(typed)).toBeNull();
    });

    it("reads what a machine reported, whatever the separators", () => {
        expect(macs.macHex("AA:bb-CC.dd ee:FF")).toBe("aabbccddeeff");
        expect(macs.macHex("00:00:00:00:00:00")).toBeNull();
        expect(macs.sameMac("aabbccddeeff", "AA:BB:CC:DD:EE:FF")).toBe(true);
        expect(macs.sameMac("aabbccddeeff", "aabbccddeef0")).toBe(false);
    });

    it("finds the MAC in a paste that brought more with it", () => {
        expect(macs.macInText("MAC: aa-bb-cc-dd-ee-f0 (Wi-Fi)")).toBe("AA:BB:CC:DD:EE:F0");
        expect(macs.macInText("Device aabbccddeef0")).toBe("AA:BB:CC:DD:EE:F0");
        expect(macs.macInText("nothing here")).toBeNull();
    });

    it("says what is wrong with a box's value", () => {
        expect(macs.macIssue("AA:BB:C")).toBe("short");
        expect(macs.macIssue("FF:FF:FF:FF:FF:FF")).toBe("reserved");
        expect(macs.macIssue("AA:BB:CC:DD:EE:F0")).toBeNull();
    });
});

/** A box holding `value` with its caret at `|`. */
function box(marked: string): macs.MacEdit {
    return { value: marked.replace("|", ""), caret: marked.indexOf("|") };
}

/** Type `text` into a box at its caret, as the browser would, then format. */
function type(state: macs.MacEdit, text: string): macs.MacEdit {
    const raw = state.value.slice(0, state.caret) + text + state.value.slice(state.caret);
    return macs.formatMacInput(raw, state.caret + text.length, state);
}

function shown(state: macs.MacEdit): string {
    return `${state.value.slice(0, state.caret)}|${state.value.slice(state.caret)}`;
}

describe("the MAC box, while typed into", () => {
    it("puts the colons in as the digits arrive, caret always after the last one", () => {
        let state = box("|");
        const steps: string[] = [];
        for (const digit of "aabbccddeeff") {
            state = type(state, digit);
            steps.push(shown(state));
        }
        expect(steps).toEqual([
            "A|",
            "AA|",
            "AA:B|",
            "AA:BB|",
            "AA:BB:C|",
            "AA:BB:CC|",
            "AA:BB:CC:D|",
            "AA:BB:CC:DD|",
            "AA:BB:CC:DD:E|",
            "AA:BB:CC:DD:EE|",
            "AA:BB:CC:DD:EE:F|",
            "AA:BB:CC:DD:EE:FF|"
        ]);
    });

    it("drops what is not a hex digit and leaves the caret where it was", () => {
        expect(shown(type(box("AA:B|"), "z"))).toBe("AA:B|");
        // A colon typed by hand is the one the box would have put there.
        expect(shown(type(box("AA|"), ":"))).toBe("AA|");
    });

    it("inserts in the middle and keeps the caret after what was typed", () => {
        expect(shown(type(box("AA|:BB"), "c"))).toBe("AA:C|B:B");
        expect(shown(type(box("A|A"), "1"))).toBe("A1|:A");
    });

    it("refuses a thirteenth digit instead of pushing the last one off", () => {
        const full = box("AA:BB|:CC:DD:EE:FF");
        expect(type(full, "1")).toBe(full);
    });

    it("reformats a paste in any spelling", () => {
        expect(shown(macs.formatMacInput("aa-bb-cc-dd-ee-ff", 17, box("|")))).toBe(
            "AA:BB:CC:DD:EE:FF|"
        );
        expect(shown(macs.formatMacInput("aabb.ccdd.eeff", 14, box("|")))).toBe(
            "AA:BB:CC:DD:EE:FF|"
        );
    });

    it("keeps the caret by digits when a selection is deleted", () => {
        // "BB:" selected in AA:BB:CC and deleted by the browser.
        expect(shown(macs.formatMacInput("AA:CC", 3, box("AA:BB:CC|")))).toBe("AA|:CC");
    });
});

describe("Backspace and Delete beside a colon", () => {
    it("Backspace right after a colon removes the digit before it", () => {
        expect(shown(macs.macBackspace("AA:BB:CC", 3)!)).toBe("A|B:BC:C");
        expect(shown(macs.macBackspace("AA:BB", 6 - 3)!)).toBe("A|B:B");
    });

    it("leaves an ordinary Backspace to the browser", () => {
        expect(macs.macBackspace("AA:BB", 5)).toBeNull();
        expect(macs.macBackspace("AA:BB", 0)).toBeNull();
    });

    it("Delete right before a colon removes the digit after it", () => {
        expect(shown(macs.macDelete("AA:BB:CC", 2)!)).toBe("AA|:BC:C");
        expect(macs.macDelete("AA:BB", 1)).toBeNull();
        expect(macs.macDelete("AA:BB", 5)).toBeNull();
    });
});
