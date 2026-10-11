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
    if (inForm) {
        const form = document.createElement("form");
        const button = document.createElement("button");
        form.append(input, button);
    } else document.body.append(input);
    return input;
}

function form(...markup: string[]): HTMLInputElement {
    const element = document.createElement("form");
    element.innerHTML = markup.join("");
    return element.querySelector("input[type=password]")!;
}

function enter(
    target: EventTarget,
    overrides: { key?: string; isComposing?: boolean; repeat?: boolean } = {}
) {
    return { key: "Enter", isComposing: false, repeat: false, target, ...overrides };
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

    it("is left to the submit event in a lone password box with no button", () => {
        const password = form("<input type=\"password\">");
        expect(enterSendsLogin(enter(password), [password])).toBe(false);
    });

    it("sends the login from a form Enter cannot submit", () => {
        const password = form(
            "<input type=\"email\">",
            "<input type=\"password\">",
            "<button type=\"button\">Sign in</button>"
        );
        expect(enterSendsLogin(enter(password), [null, password, null])).toBe(true);
    });

    it("sends the login when the form's submit button is disabled", () => {
        const password = form("<input type=\"password\">", "<button disabled></button>");
        expect(enterSendsLogin(enter(password), [password])).toBe(true);
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

    it("counts a held key once", () => {
        const password = box();
        expect(enterSendsLogin(enter(password, { repeat: true }), [password])).toBe(false);
    });

    it("ignores every other key", () => {
        const password = box();
        expect(enterSendsLogin(enter(password, { key: "a" }), [password])).toBe(false);
    });
});
