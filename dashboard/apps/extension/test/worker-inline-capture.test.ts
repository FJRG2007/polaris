// @vitest-environment jsdom
/**
 * The inline script, run on real markup against a stand-in worker: does a login
 * sent without a submit event still reach the worker to be offered for saving?
 *
 * Named `worker-` for the WXT plugin it needs (the script imports `#imports`),
 * not because it exercises the worker - the worker here is a listener that
 * records what the page asked.
 */

import type { Request } from "../src/lib/messages";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const asked: Request[] = [];

beforeAll(async () => {
    // One clock for the whole file: the script started by the first test keeps
    // its timers for the second.
    vi.useFakeTimers();
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
        const hidden = this.closest("[hidden]") !== null;
        const size = hidden ? 0 : 1;
        return {
            x: 10,
            y: 10,
            top: 10,
            left: 10,
            width: 200 * size,
            height: 30 * size,
            right: 10 + 200 * size,
            bottom: 10 + 30 * size,
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
        else if (request.kind === "captured")
            reply({ ok: true, offer: { kind: "save", name: "example.com", username: null } });
        else reply({ ok: false, error: "nothing" });
        return true;
    }) as never);
});

afterEach(() => {
    asked.length = 0;
});

// The page emptied and its last look taken while the document still exists:
// a change left pending would otherwise land after the environment is gone.
afterAll(async () => {
    document.body.innerHTML = "";
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
});

/** Let the script's timers and promises run: the look after a change is taken
 *  400 ms after it. */
async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(500);
}

function type(box: HTMLInputElement, value: string): void {
    box.value = value;
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function captured(): Request[] {
    return asked.filter((request) => request.kind === "captured");
}

describe("a login sent without a submit event", () => {
    it("is handed over when the boxes disappear right after a press", async () => {
        // Deeper than the few levels a press is tied to its boxes by, the way an
        // app's markup is: the button is in a part of the page of its own.
        document.body.innerHTML = `
            <main><section><div id="app"><div><div class="panel"><div>
                <input type="email" name="email">
                <input type="password" name="pw">
            </div></div></div></div></section></main>
            <footer><span class="cta" tabindex="0">Continue</span></footer>`;
        const { default: script } = await import("../src/entrypoints/autofill");
        void script.main?.();
        await settle();

        const email = document.querySelector<HTMLInputElement>("input[name=email]")!;
        const password = document.querySelector<HTMLInputElement>("input[name=pw]")!;
        type(email, "ana@example.com");
        type(password, "s3cret!");
        // A span nothing marks as a button, posting with fetch: no submit, and
        // too far from the boxes to be read as theirs - only remembered.
        const cta = document.querySelector<HTMLElement>(".cta")!;
        cta.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        expect(captured()).toHaveLength(0);

        // What came back replaces the form.
        document.getElementById("app")!.innerHTML = "<p>Welcome</p>";
        await settle();
        expect(captured()).toEqual([
            {
                kind: "captured",
                username: "ana@example.com",
                password: "s3cret!",
                newAccount: false
            }
        ]);

        // Its submit following later is the same login, not a second offer.
        await settle();
        expect(captured()).toHaveLength(1);
    });

    it("reads a submit from inside a shadow root", async () => {
        document.body.innerHTML = "<x-sign-in></x-sign-in>";
        const root = document.querySelector("x-sign-in")!.attachShadow({ mode: "open" });
        root.innerHTML = `
            <form>
                <input type="text" name="user" autocomplete="username">
                <input type="password" name="pass" autocomplete="current-password">
                <button type="submit">Sign in</button>
            </form>`;
        await settle();
        type(root.querySelector<HTMLInputElement>("input[name=user]")!, "luis");
        type(root.querySelector<HTMLInputElement>("input[name=pass]")!, "pa55word");
        root.querySelector("form")!.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true })
        );
        await settle();
        expect(captured()).toContainEqual({
            kind: "captured",
            username: "luis",
            password: "pa55word",
            newAccount: false
        });
    });

    it("is not sent by clicking into a box or ticking a box in the form", async () => {
        // Past the wait an earlier test's press opened.
        await vi.advanceTimersByTimeAsync(11_000);
        document.body.innerHTML = `
            <div id="app"><form>
                <input type="text" name="login" tabindex="1">
                <input type="password" name="password" tabindex="2">
                <div role="checkbox" tabindex="0" aria-checked="false">Remember me</div>
                <button type="submit">Sign in</button>
            </form></div>`;
        await settle();
        const user = document.querySelector<HTMLInputElement>("input[name=login]")!;
        type(user, "marta");
        type(document.querySelector<HTMLInputElement>("input[name=password]")!, "partial");
        user.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        document
            .querySelector("[role=checkbox]")!
            .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        expect(captured()).toHaveLength(0);

        // Neither press is one the boxes going away is read after.
        document.getElementById("app")!.innerHTML = "<p>Elsewhere</p>";
        await settle();
        expect(captured()).toHaveLength(0);
    });

    it("is not sent by leaving the page with nothing pressed", async () => {
        await vi.advanceTimersByTimeAsync(11_000);
        document.body.innerHTML = `
            <div id="app"><form>
                <input type="text" name="login">
                <input type="password" name="password">
            </form></div>
            <nav><a href="/pricing">Pricing</a></nav>`;
        await settle();
        type(document.querySelector<HTMLInputElement>("input[name=login]")!, "pablo");
        type(document.querySelector<HTMLInputElement>("input[name=password]")!, "typo-pass");
        const link = document.querySelector("a")!;
        link.addEventListener("click", (event) => event.preventDefault());
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        history.pushState(null, "", "/pricing");
        document.getElementById("app")!.innerHTML = "<p>Pricing</p>";
        window.dispatchEvent(new PopStateEvent("popstate"));
        await settle();
        expect(captured()).toHaveLength(0);
    });
});
