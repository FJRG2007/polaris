// @vitest-environment jsdom
/**
 * The sign-up menu on real markup against a stand-in worker: the open shelf's
 * identities are listed default first, and the one picked is typed into the
 * boxes that ask for each part - never over what somebody already typed.
 *
 * Named `worker-` for the WXT plugin it needs (the script imports `#imports`).
 */

import type { IdentityValues, Request } from "../src/lib/messages";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { blankIdentity } from "../src/lib/identity";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const asked: Request[] = [];
const roots: ShadowRoot[] = [];

const HOME: IdentityValues = {
    ...blankIdentity(),
    firstName: "Ana",
    lastName: "García López",
    email: "ana@example.com",
    phone: "+34 600 000 000",
    address1: "Calle Mayor 1",
    city: "Madrid"
};

beforeAll(() => {
    vi.useFakeTimers();
    // The panels are closed shadow roots; opened here so the test can press a row.
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
        const root = attach.call(this, { ...init, mode: "open" });
        roots.push(root);
        return root;
    };
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
        return {
            x: 10,
            y: 10,
            top: 10,
            left: 10,
            width: 200,
            height: 30,
            right: 210,
            bottom: 40,
            toJSON: () => ({})
        } as DOMRect;
    };
    fakeBrowser.runtime.onMessage.addListener(((
        request: Request,
        _sender: unknown,
        reply: (answer: unknown) => void
    ) => {
        asked.push(request);
        if (request.kind === "blocked") reply({ ok: true, blocked: false, host: "example.com" });
        else if (request.kind === "itemsFor") reply({ ok: true, items: [] });
        else if (request.kind === "identities")
            reply({
                ok: true,
                identities: [
                    {
                        id: "home",
                        name: "Home",
                        detail: "ana@example.com",
                        isDefault: true,
                        vault: null
                    },
                    {
                        id: "work",
                        name: "Work",
                        detail: "ana@acme.test",
                        isDefault: false,
                        vault: "Acme"
                    }
                ]
            });
        else if (request.kind === "identity" && request.id === "home")
            reply({ ok: true, identity: HOME });
        else reply({ ok: false, error: "nothing" });
        return true;
    }) as never);
});

afterAll(async () => {
    document.body.innerHTML = "";
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
});

async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(500);
}

function rows(): HTMLButtonElement[] {
    return roots.flatMap((root) => [...root.querySelectorAll<HTMLButtonElement>("button")]);
}

describe("the sign-up menu", () => {
    it("lists the identities default first and fills the one picked", async () => {
        document.body.innerHTML = `
            <form action="/register">
                <input name="first" autocomplete="given-name">
                <input name="last" autocomplete="family-name">
                <input type="email" name="email" autocomplete="email">
                <input type="tel" name="phone" autocomplete="tel">
                <input name="street" autocomplete="address-line1">
                <input name="city" autocomplete="address-level2" value="Sevilla">
                <input type="password" name="pw" autocomplete="new-password">
                <button type="submit">Create account</button>
            </form>`;
        const { default: script } = await import("../src/entrypoints/autofill");
        void script.main?.();
        await settle();

        const email = document.querySelector<HTMLInputElement>("input[name=email]")!;
        email.focus();
        email.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
        await settle();

        expect(asked.some((request) => request.kind === "identities")).toBe(true);
        const labels = rows().map((row) => row.textContent ?? "");
        const home = labels.findIndex((text) => text.startsWith("Home"));
        const work = labels.findIndex((text) => text.startsWith("Work"));
        expect(home).toBeGreaterThanOrEqual(0);
        expect(work).toBeGreaterThan(home);
        expect(labels[work]).toContain("Acme");

        rows()[home]!.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true })
        );
        await settle();

        expect(asked).toContainEqual({ kind: "identity", id: "home" });
        const value = (name: string) =>
            document.querySelector<HTMLInputElement>(`input[name=${name}]`)!.value;
        expect(value("first")).toBe("Ana");
        expect(value("last")).toBe("García López");
        expect(value("email")).toBe("ana@example.com");
        expect(value("phone")).toBe("+34 600 000 000");
        expect(value("street")).toBe("Calle Mayor 1");
        // Typed by hand before the pick: kept.
        expect(value("city")).toBe("Sevilla");
    });
});
