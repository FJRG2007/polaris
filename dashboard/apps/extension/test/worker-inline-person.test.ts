// @vitest-environment jsdom
/**
 * A Spanish application form, filled from an identity picked on its name box:
 * both surnames even where the page marks both `family-name`, the identity
 * document, the date of birth as a day box, a month dropdown named in words
 * and a year box under a "Fecha de nacimiento" group, the country of birth and
 * the marital status dropdowns, and the email and phone typed a second time.
 * The address country is never put in the country of birth.
 *
 * Named `worker-` for the WXT plugin it needs (the script imports `#imports`).
 */

import { blankIdentity } from "../src/lib/identity";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { IdentityValues, Request } from "../src/lib/messages";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const asked: Request[] = [];
const roots: ShadowRoot[] = [];

const HOME: IdentityValues = {
    ...blankIdentity(),
    firstName: "Ana",
    lastName: "García López",
    email: "ana@example.com",
    phone: "+34600000000",
    country: "FR",
    nationalId: "12345678Z",
    birthDate: "1990-05-04",
    birthCountry: "ES",
    maritalStatus: "married"
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
                        preview: { email: "ana@example.com", phone: "", address: "", name: "Ana García López" }
                    }
                ]
            });
        else if (request.kind === "identity" && request.id === "home") reply({ ok: true, identity: HOME });
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

describe("a Spanish application form", () => {
    it("fills the surnames apart, the document, the date of birth and the rest", async () => {
        document.documentElement.lang = "es";
        document.body.innerHTML = `
            <form>
                <label for="n">Nombre *</label><input id="n" name="name1">
                <label for="a1">Primer Apellido *</label><input id="a1" name="ap1" autocomplete="family-name">
                <label for="a2">Segundo Apellido</label><input id="a2" name="ap2" autocomplete="family-name">
                <label for="doc">Tu documento de identidad (DNI/NIE/TIE) *</label><input id="doc" name="docId">
                <label for="e1">Tu email *</label><input id="e1" name="mail" type="email">
                <label for="e2">Confirma tu email *</label><input id="e2" name="mail2" type="email">
                <fieldset>
                    <legend>Tu fecha de nacimiento</legend>
                    <label for="d">Día</label><input id="d" name="d" maxlength="2">
                    <label for="m">Mes</label>
                    <select id="m" name="m">
                        <option value="">Mes</option>
                        <option value="a">Enero</option><option value="b">Febrero</option>
                        <option value="c">Marzo</option><option value="d">Abril</option>
                        <option value="e">Mayo</option><option value="f">Junio</option>
                    </select>
                    <label for="y">Año</label><input id="y" name="y" maxlength="4">
                </fieldset>
                <label for="pc">País de nacimiento *</label>
                <select id="pc" name="pc">
                    <option value="">Selecciona</option>
                    <option value="FRA">Francia</option>
                    <option value="ESP">España</option>
                </select>
                <label for="ec">Estado civil *</label>
                <select id="ec" name="ec">
                    <option value="">Selecciona</option>
                    <option value="1">Soltero/a</option>
                    <option value="2">Casado/a</option>
                    <option value="3">Pareja de hecho</option>
                </select>
                <label for="t1">Tu teléfono móvil *</label><input id="t1" name="tel1" type="tel">
                <label for="t2">Confirma tu teléfono móvil *</label><input id="t2" name="tel2" type="tel">
                <button type="submit">Siguiente</button>
            </form>`;

        const { default: script } = await import("../src/entrypoints/autofill");
        void script.main?.();
        await settle();

        const name = document.querySelector<HTMLInputElement>("#n")!;
        name.focus();
        name.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
        await settle();

        const home = rows().find((row) => (row.textContent ?? "").includes("Ana García López"));
        expect(home).toBeDefined();
        home!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        await settle();
        await vi.advanceTimersByTimeAsync(2_500);

        const value = (id: string) => document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.value;
        expect(value("n")).toBe("Ana");
        expect(value("a1")).toBe("García");
        expect(value("a2")).toBe("López");
        expect(value("doc")).toBe("12345678Z");
        expect(value("e1")).toBe("ana@example.com");
        expect(value("e2")).toBe("ana@example.com");
        expect(value("d")).toBe("04");
        expect(value("m")).toBe("e");
        expect(value("y")).toBe("1990");
        expect(value("pc")).toBe("ESP");
        expect(value("ec")).toBe("2");
        expect(value("t1")).toBe("+34600000000");
        expect(value("t2")).toBe("+34600000000");
    });
});
