// @vitest-environment jsdom
/**
 * The generator shows, and copies, the password a box was filled with; and a
 * sign-up that never fires a submit is still seen going.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    GENERATED_HOOK,
    generatedPasswords,
    isShowing,
    requestSendsForm,
    stillHolds
} from "@/lib/submit-signals";

function input(value = ""): HTMLInputElement {
    const box = document.createElement("input");
    box.type = "password";
    box.value = value;
    document.body.append(box);
    return box;
}

describe("a password made for a box", () => {
    it("is the one shown again while the box holds it", () => {
        const made = generatedPasswords();
        const box = input();
        box.value = "Fixture-Generated-1";
        made.remember(box, "Fixture-Generated-1");
        expect(made.inBox(box)).toBe("Fixture-Generated-1");
    });

    it("is forgotten once somebody types over it", () => {
        const made = generatedPasswords();
        const box = input("Fixture-Generated-2");
        made.remember(box, "Fixture-Generated-2");
        box.value = "typed by hand";
        expect(made.inBox(box)).toBeNull();
    });

    it("is nothing on a box it was never made for", () => {
        const made = generatedPasswords();
        made.remember(input("a"), "a");
        expect(made.inBox(input("a"))).toBeNull();
    });

    it("is announced by the worker under the name the page script answers to", () => {
        const worker = readFileSync(join(process.cwd(), "src/entrypoints/background.ts"), "utf8");
        expect(worker).toContain(`["${GENERATED_HOOK}"]`);
    });
});

describe("a form going out of sight", () => {
    it("counts a box removed from the page as gone", () => {
        const box = input("secret");
        box.remove();
        expect(stillHolds([box], "secret")).toBe(false);
    });

    it("counts a box hidden by the next step as gone", () => {
        const step = document.createElement("div");
        const box = document.createElement("input");
        box.value = "secret";
        step.append(box);
        document.body.append(step);
        expect(stillHolds([box], "secret")).toBe(true);
        step.style.display = "none";
        expect(isShowing(box)).toBe(false);
        expect(stillHolds([box], "secret")).toBe(false);
        step.style.display = "";
        step.hidden = true;
        expect(stillHolds([box], "secret")).toBe(false);
    });

    it("keeps a box still holding the password on screen", () => {
        expect(stillHolds([null, input("secret")], "secret")).toBe(true);
        expect(stillHolds([input("changed")], "secret")).toBe(false);
    });
});

describe("a request after the button is pressed", () => {
    const pressed = 1_000_000;
    const within = 10_000;

    it("is the form going when a script sends it soon after the press", () => {
        expect(
            requestSendsForm({ initiatorType: "fetch", startedAt: pressed + 50 }, pressed, within)
        ).toBe(true);
        expect(
            requestSendsForm(
                { initiatorType: "xmlhttprequest", startedAt: pressed + 900, responseStatus: 302 },
                pressed,
                within
            )
        ).toBe(true);
    });

    it("is not one refused, before the press, too late, or with no press at all", () => {
        const at = (startedAt: number, responseStatus?: number) => ({
            initiatorType: "fetch",
            startedAt,
            responseStatus
        });
        expect(requestSendsForm(at(pressed + 10, 401), pressed, within)).toBe(false);
        expect(requestSendsForm(at(pressed - 10), pressed, within)).toBe(false);
        expect(requestSendsForm(at(pressed + within + 1), pressed, within)).toBe(false);
        expect(requestSendsForm(at(10), 0, within)).toBe(false);
    });

    it("is not an image or a stylesheet the page loads", () => {
        expect(
            requestSendsForm({ initiatorType: "img", startedAt: pressed + 10 }, pressed, within)
        ).toBe(false);
    });
});
