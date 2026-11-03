// @vitest-environment jsdom
/**
 * The identity menu opened on an address box with no form around it, against
 * a stand-in worker: the pick replaces the whole address, sets the address's
 * own country dropdown and the region list the page refills after it, types
 * the code into a country box that asks for one, and leaves a site-wide
 * country picker elsewhere on the page as it was.
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
    address1: "Calle Mayor 1",
    city: "Madrid",
    state: "Madrid",
    postalCode: "28013",
    country: "ES"
};

beforeAll(() => {
    vi.useFakeTimers();
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
    // jsdom lays nothing out; a dropdown only counts when it is drawn.
    HTMLElement.prototype.getClientRects = function (this: HTMLElement): DOMRectList {
        const rects = [this.getBoundingClientRect()];
        return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as never;
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
                        vault: null,
                        preview: {
                            email: "ana@example.com",
                            phone: "",
                            address: "Calle Mayor 1, Madrid",
                            name: "Ana García López"
                        }
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

describe("the identity menu on a formless address", () => {
    it("replaces the address and fills its own dropdowns, never the page's picker", async () => {
        document.body.innerHTML = `
            <header>
                <select name="country" aria-label="Country">
                    <option value="US">United States</option>
                    <option value="FR" selected>France</option>
                    <option value="ES">Spain</option>
                </select>
            </header>
            <main>
                <div class="checkout">
                    <input name="street" autocomplete="address-line1">
                    <input name="extra" autocomplete="address-line2" value="Piso 3">
                    <input name="city" autocomplete="address-level2" value="Sevilla">
                    <input name="zip" autocomplete="postal-code" maxlength="5">
                    <input name="cc" autocomplete="shipping country">
                    <div class="selects">
                        <select name="ship_country" aria-label="Country">
                            <option value="">Select a country</option>
                            <option value="FR">France</option>
                            <option value="ES">España</option>
                        </select>
                        <select name="ship_state" aria-label="State / Province">
                            <option value="">Select a region</option>
                        </select>
                    </div>
                </div>
            </main>`;
        const shipCountry = document.querySelector<HTMLSelectElement>("select[name=ship_country]")!;
        const shipState = document.querySelector<HTMLSelectElement>("select[name=ship_state]")!;
        const headerCountry = document.querySelector<HTMLSelectElement>("header select")!;
        const headerChanges = vi.fn();
        headerCountry.addEventListener("change", headerChanges);
        // The region list is refilled after a request once the country changes.
        shipCountry.addEventListener("change", () => {
            setTimeout(() => {
                shipState.innerHTML = `
                    <option value="">Select a region</option>
                    <option value="AN">Andalucía</option>
                    <option value="MD">Comunidad de Madrid</option>`;
            }, 300);
        });

        const { default: script } = await import("../src/entrypoints/autofill");
        void script.main?.();
        await settle();

        const street = document.querySelector<HTMLInputElement>("input[name=street]")!;
        street.focus();
        street.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
        await settle();

        expect(asked.some((request) => request.kind === "identities")).toBe(true);
        const home = rows().find((row) => (row.textContent ?? "").includes("Calle Mayor 1"));
        expect(home).toBeDefined();
        home!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        await settle();
        await vi.advanceTimersByTimeAsync(2_500);

        expect(asked).toContainEqual({ kind: "identity", id: "home" });
        const value = (name: string) =>
            document.querySelector<HTMLInputElement>(`input[name=${name}]`)!.value;
        expect(value("street")).toBe("Calle Mayor 1");
        // The rest of the address is replaced with the pick, filled or not.
        expect(value("city")).toBe("Madrid");
        expect(value("extra")).toBe("");
        expect(value("zip")).toBe("28013");
        // A box whose token is `country` takes the code.
        expect(value("cc")).toBe("ES");

        expect(shipCountry.value).toBe("ES");
        expect(shipState.value).toBe("MD");
        expect(headerCountry.value).toBe("FR");
        expect(headerChanges).not.toHaveBeenCalled();
    });
});
