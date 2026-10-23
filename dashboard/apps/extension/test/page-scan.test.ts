// @vitest-environment jsdom
/**
 * A corpus of the sign-in and sign-up shapes real sites ship, run through the
 * same scan and rules the page runs.
 *
 * Each fixture is markup of the kind a site actually serves - trimmed to the
 * boxes and buttons that decide the answer - and the assertion is what the
 * inline script would then offer. The shapes are the ones the major password
 * managers document and test for: a two-page sign-in, a component with no
 * `<form>`, a design system's shadow root, a sign-in inside a frame, the
 * `autocomplete` tokens with a qualifier on them, and a sign-up that says what
 * it is only on its button.
 */

import { readForm, type PageFields } from "@/lib/fields";
import { changeNeeds, describeInput, formOf, scanInputs } from "@/lib/page-scan";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** jsdom lays nothing out, so every box would read as invisible: give each one
 *  a size unless it, or something around it, is hidden. */
function layOut(view: Window & typeof globalThis): void {
    view.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
        const hidden =
            this.closest("[hidden]") !== null ||
            this.style.display === "none" ||
            (this as HTMLInputElement).type === "hidden";
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
}

beforeEach(() => layOut(window));
afterEach(() => {
    document.body.innerHTML = "";
});

/** What the page would be read as, and the inputs it was read from. */
function read(html?: string): { fields: PageFields; inputs: HTMLInputElement[] } {
    if (html !== undefined) document.body.innerHTML = html;
    const { inputs } = scanInputs(document);
    return { fields: readForm(inputs.map(describeInput)), inputs };
}

/** The `name` (or id) of the input at a position, to assert on by name. */
function nameAt(inputs: HTMLInputElement[], index: number | null): string | null {
    if (index === null) return null;
    const input = inputs[index];
    return input ? input.name || input.id : null;
}

describe("two-page sign-ins", () => {
    it("finds the identifier on the first page of a Google-style sign-in", () => {
        const { fields, inputs } = read(`
            <form>
                <input type="email" id="identifierId" name="identifier"
                    autocomplete="username webauthn" aria-label="Email or phone">
                <button type="button">Next</button>
            </form>`);
        expect(nameAt(inputs, fields.username)).toBe("identifier");
        expect(fields.password).toBeNull();
        expect(fields.purpose).toBe("none");
    });

    it("finds the password on the second page, past the hidden username", () => {
        const { fields, inputs } = read(`
            <form>
                <input type="email" name="identifier" hidden value="ana@example.com">
                <input type="password" name="Passwd" autocomplete="current-password"
                    aria-label="Enter your password">
                <button type="button">Next</button>
            </form>`);
        expect(nameAt(inputs, fields.password)).toBe("Passwd");
        expect(fields.username).toBeNull();
        expect(fields.purpose).toBe("signin");
    });

    it("finds a Microsoft-style first page by its autocomplete token", () => {
        const { fields, inputs } = read(`
            <form name="f1">
                <input type="email" name="loginfmt" autocomplete="username"
                    placeholder="Email, phone, or Skype">
                <input type="submit" value="Next">
            </form>`);
        expect(nameAt(inputs, fields.username)).toBe("loginfmt");
    });

    it("finds a username and password split across the same page by steps", () => {
        // Both boxes in the markup from the start, the password parked off screen
        // until the first step is done - the page then reveals it.
        document.body.innerHTML = `
            <form>
                <input type="email" name="email" id="ap_email">
                <div id="step2" hidden><input type="password" name="password"></div>
            </form>`;
        let { fields, inputs } = read();
        expect(nameAt(inputs, fields.username)).toBe("email");
        expect(fields.password).toBeNull();

        document.getElementById("step2")?.removeAttribute("hidden");
        ({ fields, inputs } = read());
        expect(nameAt(inputs, fields.password)).toBe("password");
        expect(nameAt(inputs, fields.username)).toBe("email");
    });
});

describe("sign-ins written as components", () => {
    it("reads a React sign-in with no form, skipping the search box above it", () => {
        const { fields, inputs } = read(`
            <header><input type="search" name="q" placeholder="Search"></header>
            <div class="panel"><div class="fields">
                <input type="text" name="j_id7">
                <input type="password" name="pw">
            </div><div role="button" tabindex="0">Continue</div></div>`);
        expect(nameAt(inputs, fields.password)).toBe("pw");
        // Named nothing a rule knows: the box right before the password.
        expect(nameAt(inputs, fields.username)).toBe("j_id7");
    });

    it("takes a box labelled only 'ID' as the username before a password", () => {
        const { fields, inputs } = read(`
            <form>
                <label for="u">ID</label><input id="u" name="x1">
                <label for="p">PIN</label><input id="p" type="password" name="x2">
            </form>`);
        expect(nameAt(inputs, fields.username)).toBe("x1");
    });

    it("does not take a company box for the username", () => {
        const { fields } = read(`
            <form>
                <input name="company" placeholder="Company">
                <input type="password" name="pw">
            </form>`);
        expect(fields.username).toBeNull();
    });

    it("finds the boxes inside a design system's shadow root", () => {
        document.body.innerHTML = "<x-login></x-login>";
        const host = document.querySelector("x-login")!;
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = `
            <label for="user">Username</label><input id="user" name="user">
            <input type="password" name="secret" aria-label="Password">
            <button>Sign in</button>`;
        const { fields, inputs } = read();
        expect(nameAt(inputs, fields.username)).toBe("user");
        expect(nameAt(inputs, fields.password)).toBe("secret");
    });

    it("reaches a nested shadow root, in reading order", () => {
        document.body.innerHTML = `<input name="q" type="search"><x-card></x-card>`;
        const outer = document.querySelector("x-card")!.attachShadow({ mode: "open" });
        outer.innerHTML = `<x-field></x-field><input type="password" name="pw">`;
        const inner = outer.querySelector("x-field")!.attachShadow({ mode: "open" });
        inner.innerHTML = `<input type="email" name="mail">`;
        const { fields, inputs } = read();
        expect(inputs.map((input) => input.name)).toEqual(["q", "mail", "pw"]);
        expect(nameAt(inputs, fields.username)).toBe("mail");
    });

    it("asks for closed roots on custom elements only", () => {
        document.body.innerHTML = `<div id="plain"></div><x-closed></x-closed>`;
        const closed = document.querySelector("x-closed")!.attachShadow({ mode: "closed" });
        closed.innerHTML = `<input type="password" name="hidden-away">`;
        const asked: string[] = [];
        const { inputs } = scanInputs(document, (element) => {
            asked.push(element.localName);
            return element.localName === "x-closed" ? closed : null;
        });
        expect(asked).toEqual(["x-closed"]);
        expect(inputs.map((input) => input.name)).toEqual(["hidden-away"]);
    });

    it("walks up out of a shadow root to find the panel", () => {
        document.body.innerHTML = `<section id="panel"><div><x-field></x-field></div></section>`;
        const root = document.querySelector("x-field")!.attachShadow({ mode: "open" });
        root.innerHTML = `<div><input name="deep"></div>`;
        const input = root.querySelector("input")!;
        expect(formOf(input)).not.toBeNull();
    });
});

describe("sign-ins inside a frame", () => {
    it("reads a same-origin frame's form", () => {
        document.body.innerHTML = "<iframe></iframe>";
        const frame = document.querySelector("iframe")!;
        const inner = frame.contentDocument!;
        layOut(frame.contentWindow as Window & typeof globalThis);
        inner.body.innerHTML = `
            <form>
                <input type="text" name="username" autocomplete="username">
                <input type="password" name="password" autocomplete="current-password">
            </form>`;
        const scan = scanInputs(document);
        expect(scan.trees).toContain(inner);
        const fields = readForm(scan.inputs.map(describeInput));
        expect(nameAt(scan.inputs, fields.username)).toBe("username");
        expect(fields.purpose).toBe("signin");
    });
});

describe("what a form is for", () => {
    it("reads a sign-up by its autocomplete tokens, with both halves of the name", () => {
        const { fields, inputs } = read(`
            <form>
                <input name="first" autocomplete="given-name">
                <input name="last" autocomplete="family-name">
                <input type="email" name="email" autocomplete="email">
                <input type="password" name="pw" autocomplete="new-password">
                <input type="password" name="pw2" autocomplete="new-password"
                    placeholder="Confirm password">
            </form>`);
        expect(fields.purpose).toBe("signup");
        expect(nameAt(inputs, fields.givenName)).toBe("first");
        expect(nameAt(inputs, fields.familyName)).toBe("last");
        expect(nameAt(inputs, fields.username)).toBe("email");
        expect(nameAt(inputs, fields.newPassword)).toBe("pw");
        expect(nameAt(inputs, fields.confirmPassword)).toBe("pw2");
    });

    it("reads a lone unlabelled password as new when the button creates an account", () => {
        const { fields, inputs } = read(`
            <form action="/join">
                <input type="email" name="email">
                <input type="password" name="password">
                <button type="submit">Create account</button>
            </form>`);
        expect(fields.purpose).toBe("signup");
        expect(nameAt(inputs, fields.newPassword)).toBe("password");
        expect(fields.password).toBeNull();
    });

    it("reads it as a sign-up in Spanish too", () => {
        const { fields } = read(`
            <form>
                <input type="email" name="correo">
                <input type="password" name="clave">
                <button>Crear cuenta</button>
            </form>`);
        expect(fields.purpose).toBe("signup");
    });

    it("keeps a sign-in a sign-in when a sign-up link sits beside its button", () => {
        const { fields } = read(`
            <form>
                <input type="email" name="email">
                <input type="password" name="password">
                <button type="submit">Sign in</button>
                <a href="/signup">No account? Sign up</a>
            </form>`);
        expect(fields.purpose).toBe("signin");
    });

    it("reads a password in a named section", () => {
        const { fields, inputs } = read(`
            <form>
                <input name="login" autocomplete="section-main username">
                <input type="password" name="pw" autocomplete="section-main current-password">
            </form>`);
        expect(fields.purpose).toBe("signin");
        expect(nameAt(inputs, fields.username)).toBe("login");
    });

    it("reads a passkey-enabled password box as the current password", () => {
        const { fields } = read(`
            <form>
                <input type="text" name="u" autocomplete="username webauthn">
                <input type="password" name="p" autocomplete="current-password webauthn">
            </form>`);
        expect(fields.purpose).toBe("signin");
        expect(fields.username).toBe(0);
        expect(fields.password).toBe(1);
    });

    it("reads aria-labelledby as the box's label", () => {
        const { fields, inputs } = read(`
            <form>
                <span id="lbl">Usuario</span><input name="a1" aria-labelledby="lbl">
                <input name="note" placeholder="Anything else">
                <input type="password" name="a2">
            </form>`);
        expect(nameAt(inputs, fields.username)).toBe("a1");
    });
});

describe("how much looking a page change calls for", () => {
    /** The records `change` makes on the page, the way the observer sees them. */
    function recordsOf(change: () => void): MutationRecord[] {
        const observer = new MutationObserver(() => undefined);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["style", "class", "hidden", "aria-hidden", "disabled", "type"]
        });
        change();
        const records = observer.takeRecords();
        observer.disconnect();
        return records;
    }
    const nobody = (): boolean => false;

    it("walks again when a box, a frame or a component arrives", () => {
        for (const markup of [
            "<input>",
            "<div><p><input></p></div>",
            "<iframe></iframe>",
            "<x-field></x-field>",
            "<div><x-field></x-field></div>"
        ]) {
            const records = recordsOf(() => {
                const holder = document.createElement("div");
                holder.innerHTML = markup;
                document.body.append(holder.firstElementChild as Element);
            });
            expect(changeNeeds(records, nobody, 0)).toBe("rescan");
        }
    });

    it("walks again when a box is taken away", () => {
        document.body.innerHTML = "<form><input name=a></form>";
        const records = recordsOf(() => document.querySelector("form")?.remove());
        expect(changeNeeds(records, nobody, 1)).toBe("rescan");
    });

    it("leaves a video player's own churn alone", () => {
        document.body.innerHTML =
            "<div class=player><span class=bar></span><p class=subs></p></div>";
        const records = recordsOf(() => {
            document.querySelector(".bar")?.setAttribute("style", "width: 40%");
            document.querySelector(".player")?.classList.add("playing");
            const line = document.createElement("span");
            line.textContent = "subtitle";
            document.querySelector(".subs")?.replaceChildren(line);
        });
        expect(changeNeeds(records, nobody, 0)).toBe("none");
    });

    it("re-reads the boxes it has when a style or class may have shown one", () => {
        document.body.innerHTML = "<div class=step hidden><input type=password></div>";
        const records = recordsOf(() => document.querySelector(".step")?.removeAttribute("hidden"));
        expect(changeNeeds(records, nobody, 1)).toBe("reread");
    });

    it("never counts its own marks", () => {
        const mark = document.createElement("x-mark");
        const records = recordsOf(() => {
            document.body.append(mark);
            mark.style.top = "10px";
        });
        expect(changeNeeds(records, (node) => node === mark, 1)).toBe("none");
    });
});
