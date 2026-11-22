// @vitest-environment jsdom

/**
 * Seeing unfinished work from the page itself, so no screen has to report it.
 *
 * Pinned, as the owner put the cases: a provider form half filled and not
 * focused, a task dialog open, and a save on its way each keep the tab from
 * reloading for an update; a field typed into and put back does not; and what
 * is unsaved when the page goes away is put back on the next one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/transfers/transfer-store", () => ({
    transfersNow: () => [],
    isUnderWay: () => false
}));

let release: (() => void) | null = null;
vi.stubGlobal(
    "fetch",
    vi.fn(
        (_input: unknown, init?: RequestInit) =>
            new Promise<Response>((resolve) => {
                if (init?.method === "POST") release = () => resolve(new Response("{}"));
                else resolve(new Response("{}"));
            })
    )
);

const work = await import("@/lib/work-in-progress");
const { safeToReload } = await import("@/lib/reload-safety");
work.watchWorkInProgress();

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
}

function providerForm(): { form: HTMLFormElement; name: HTMLInputElement; key: HTMLInputElement } {
    const form = document.createElement("form");
    const name = document.createElement("input");
    name.name = "provider-name";
    const key = document.createElement("input");
    key.type = "password";
    key.name = "provider-key";
    form.append(name, key);
    document.body.append(form);
    return { form, name, key };
}

afterEach(() => {
    document.body.innerHTML = "";
    window.sessionStorage.clear();
    work.resetWorkInProgress();
    release = null;
});

describe("unfinished work keeps the update waiting", () => {
    it("a provider form half filled and no longer focused", () => {
        const { name } = providerForm();
        type(name, "My provider");
        name.blur();
        (document.activeElement as HTMLElement | null)?.blur();
        expect(safeToReload()).toBe(false);
    });

    it("a field typed into and put back is clean again", () => {
        const { name } = providerForm();
        type(name, "x");
        name.value = "";
        name.dispatchEvent(new Event("input", { bubbles: true }));
        expect(safeToReload()).toBe(true);
    });

    it("a form that was sent has nothing unsaved left", () => {
        const { form, name } = providerForm();
        type(name, "My provider");
        form.dispatchEvent(new Event("submit", { bubbles: true }));
        expect(safeToReload()).toBe(true);
    });

    it("a task dialog open, even with nothing typed yet", () => {
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("data-state", "open");
        document.body.append(dialog);
        expect(safeToReload()).toBe(false);
        dialog.setAttribute("data-state", "closed");
        expect(safeToReload()).toBe(true);
    });

    it("a save or server action still on its way", async () => {
        const sent = window.fetch("/x", { method: "POST" });
        expect(safeToReload()).toBe(false);
        await window.fetch("/api/version");
        expect(safeToReload()).toBe(false);
        release?.();
        await sent;
        expect(safeToReload()).toBe(true);
    });

    it("a checkbox flipped, until it is flipped back", () => {
        const box = document.createElement("input");
        box.type = "checkbox";
        document.body.append(box);
        box.click();
        expect(safeToReload()).toBe(false);
        box.click();
        expect(safeToReload()).toBe(true);
    });

    it("leaves a box that keeps its own draft to it", () => {
        const kept = document.createElement("div");
        kept.setAttribute("data-reload-keeps", "");
        const draft = document.createElement("textarea");
        kept.append(draft);
        document.body.append(kept);
        type(draft, "a chat draft");
        expect(safeToReload()).toBe(true);
    });
});

describe("nothing is lost across a reload", () => {
    it("writes the unsaved fields down, never a password, and puts them back when they appear", () => {
        const { name, key } = providerForm();
        type(name, "My provider");
        type(key, "sk-secret");
        work.saveUnsavedFields();
        const written = window.sessionStorage.getItem("polaris.unsavedFields") ?? "";
        expect(written).toContain("My provider");
        expect(written).not.toContain("sk-secret");

        // The next page: the form is drawn after the restore starts, as a
        // dialog opened again by hand would be.
        document.body.innerHTML = "";
        work.resetWorkInProgress();
        const stop = work.restoreUnsavedFields();
        const again = providerForm();
        const heard = vi.fn();
        again.name.addEventListener("input", heard);
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                expect(again.name.value).toBe("My provider");
                expect(heard).toHaveBeenCalled();
                expect(again.key.value).toBe("");
                expect(window.sessionStorage.getItem("polaris.unsavedFields")).toBeNull();
                stop();
                resolve();
            }, 0);
        });
    });

    it("never writes over what was typed on the new page, nor fills another address", () => {
        window.sessionStorage.setItem(
            "polaris.unsavedFields",
            JSON.stringify({ url: "/elsewhere", at: Date.now(), fields: [{ selector: "#title", value: "Old", rich: false }] })
        );
        const field = document.createElement("input");
        field.id = "title";
        document.body.append(field);
        work.restoreUnsavedFields()();
        expect(field.value).toBe("");

        window.sessionStorage.setItem(
            "polaris.unsavedFields",
            JSON.stringify({
                url: location.pathname + location.search,
                at: Date.now(),
                fields: [{ selector: "#title", value: "Old", rich: false }]
            })
        );
        field.value = "Newer";
        work.restoreUnsavedFields()();
        expect(field.value).toBe("Newer");
    });
});
