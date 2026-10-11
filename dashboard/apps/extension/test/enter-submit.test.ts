// @vitest-environment jsdom
/**
 * Enter in a login box with no form around it is the one way a sign-in can be
 * sent that neither a submit nor a button press reports.
 */

import { describe, expect, it } from "vitest";
import { enterSendsLogin } from "@/lib/enter-submit";

function box(inForm = false): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "password";
    if (inForm) document.createElement("form").append(input);
    else document.body.append(input);
    return input;
}

function enter(target: EventTarget, overrides: { key?: string; isComposing?: boolean } = {}) {
    return { key: "Enter", isComposing: false, target, ...overrides };
}

describe("an Enter press", () => {
    it("sends the login from a password box with no form", () => {
        const password = box();
        expect(enterSendsLogin(enter(password), [null, password, null])).toBe(true);
    });

    it("is left to the submit event inside a form", () => {
        const password = box(true);
        expect(enterSendsLogin(enter(password), [null, password, null])).toBe(false);
    });

    it("is not a login when it is in some other box", () => {
        const password = box();
        const search = box();
        expect(enterSendsLogin(enter(search), [null, password, null])).toBe(false);
    });

    it("is not sent while a word is still being composed", () => {
        const password = box();
        expect(enterSendsLogin(enter(password, { isComposing: true }), [password])).toBe(false);
    });

    it("ignores every other key", () => {
        const password = box();
        expect(enterSendsLogin(enter(password, { key: "a" }), [password])).toBe(false);
    });
});
