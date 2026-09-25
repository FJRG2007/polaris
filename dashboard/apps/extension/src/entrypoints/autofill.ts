/**
 * What Polaris offers on the page itself, rather than from the toolbar.
 *
 * An unlisted script, deliberately: a content script declared in the manifest
 * carries its `matches` into `host_permissions`, and the browser then tells
 * everybody who installs this that it may read every page they open. That is the
 * access this extension has always refused to ask for. This file is built as a
 * standalone bundle with no manifest entry at all, and the worker registers it at
 * runtime for the origins somebody has actually granted - so the promise made at
 * install time is the same one as before, and what is below appears only where it
 * was asked for.
 *
 * Four things, each on the box it belongs to:
 *
 * - **The login**, offered on the username or password box. Choosing one sends
 *   the same `fill` message the popup sends, so the two strings reach the page
 *   exactly where they always did and no new path carries a password. This script
 *   never sees one: it asks for names and gets names. On a site with nothing
 *   saved, or a sign-up form, the same menu offers your own email and name and a
 *   password made on the spot - the account you are about to create.
 * - **A password to use**, offered on the box a new one is being invented in.
 *   Made here by `@polaris/core`'s generator, the same one the popup and the web
 *   vault use, and typed into the new-password box and its confirmation together.
 * - **The authenticator's code**, offered on a one-time-code box, computed in the
 *   worker so the secret behind it stays there.
 * - **Saving what was just typed.** A form going is the only moment somebody has
 *   both halves of a credential in one place, and it is also the moment the page
 *   is about to be replaced - so the values go to the worker as the form goes,
 *   and the worker holds the offer until the page that lands can draw it.
 *
 * Everything it draws is inside a closed shadow root, because the alternative is
 * a menu wearing whatever CSS the page happens to have - and a login chooser that
 * a page can restyle is a login chooser a page can disguise.
 *
 * What it deliberately does not do: submit anything. Filling, generating and
 * offering are the help somebody asked for; pressing the button for them is a
 * decision nobody made.
 */

import { storage } from "#imports";
import { generatePassword } from "@polaris/core/password-generator";
import {
    GENERATOR_DEFAULTS,
    GENERATOR_KEY,
    readGeneratorOptions,
    type GeneratorOptions
} from "@/lib/generator";
import { readForm, type FieldFacts, type PageFields } from "@/lib/fields";
import { askBackground, type ItemSummary, type OfferedCapture } from "@/lib/messages";

/** How long to wait for a page to stop changing before looking again. Logins
 *  arrive late on most sites now - a form is rendered after the framework has
 *  fetched something - so one look at load would miss them. */
const SETTLE_MS = 400;

/** How long after the last keystroke a password is asked about. Long enough that
 *  typing one does not make a request per character. */
const BREACH_AFTER_MS = 800;

/** The mark's size, and the room it needs at the right edge of a field. */
const MARK = 18;

/** Polaris's own violet, which is what makes the mark recognisable as ours on a
 *  page that knows nothing about it. */
const BRAND = "hsl(258 82% 62%)";

/** The three things a mark can be for. */
type Role = "login" | "generate" | "code";

/** Every one of them, to walk in a fixed order. */
const ROLES = ["login", "generate", "code"] as const satisfies readonly Role[];

/** What each mark says it is for, before anything is opened. */
const TITLES: Record<Role, string> = {
    login: "Fill from Polaris",
    generate: "Make a password with Polaris",
    code: "Fill the code from Polaris"
};

export default defineUnlistedScript({
    main() {
        // Never in a frame that is not the page: an advert's iframe has inputs
        // too, and offering somebody's password inside one is the whole shape of
        // a clickjacking.
        if (window.top !== window) return;
        void start();
    }
});

async function start(): Promise<void> {
    // Two questions the page must not decide: whether this site was switched
    // off, and whether there is an open vault to offer anything from. Both are
    // the worker's, and both are re-asked whenever a menu opens rather than
    // cached here - a vault that locks while a tab sits open must stop offering.
    const here = await askBackground({ kind: "blocked" });
    if (!here.ok || !("blocked" in here) || here.blocked) return;

    // A login submitted on the page before this one. Asked for first, because the
    // navigation that submitting caused is what loaded this script, and the offer
    // is the whole reason anybody typed anything.
    void offerHeld();

    const marks = new Map<Role, { field: HTMLInputElement; host: HTMLElement }>();
    let open = false;
    /** The boxes as of the last look, so a submit does not have to find them
     *  again on a page that is already being taken apart. */
    let seen: { fields: PageFields; inputs: HTMLInputElement[] } = {
        fields: {
            username: null,
            password: null,
            newPassword: null,
            confirmPassword: null,
            oneTimeCode: null,
            oneTimeCodeBoxes: [],
            fullName: null,
            givenName: null,
            familyName: null,
            purpose: "none"
        },
        inputs: []
    };

    const look = (): void => {
        const inputs = [...document.querySelectorAll("input")];
        seen = { fields: readForm(inputs.map(describe)), inputs };
    };

    const at = (index: number | null): HTMLInputElement | null =>
        index === null ? null : (seen.inputs[index] ?? null);

    /** Move the marks to where their boxes are now. Called on every scroll, so it
     *  touches the DOM and nothing else. */
    const place = (): void => {
        for (const { field, host } of marks.values()) {
            const box = field.getBoundingClientRect();
            // Fixed rather than absolute: a field inside a scrolling panel moves
            // without the document scrolling, and `position: absolute` would leave
            // the mark behind on the page.
            host.style.top = `${box.top + (box.height - MARK) / 2}px`;
            host.style.left = `${box.right - MARK - 6}px`;
            host.style.display = box.width < 60 || box.height < 16 ? "none" : "block";
        }
    };

    /** Look again at what the page is asking for, and put a mark on each box that
     *  Polaris has something to offer for. */
    const refresh = (): void => {
        look();
        const { fields } = seen;
        // The login mark sits on the name where there is one and on the password
        // otherwise, because that is where somebody's eye already is.
        const wanted: Record<Role, HTMLInputElement | null> = {
            login: at(fields.username) ?? at(fields.password),
            generate: at(fields.newPassword),
            code: at(fields.oneTimeCode)
        };

        for (const role of ROLES) {
            const field = wanted[role];
            const held = marks.get(role);
            if (held && (!field || held.field !== field)) {
                held.host.remove();
                marks.delete(role);
            }
            if (!field) continue;
            const host = marks.get(role)?.host ?? mark(role, () => void show(role, field));
            marks.set(role, { field, host });
        }

        place();
        watchForBreaches(at(fields.newPassword));
        claimCode();
    };

    /**
     * Type the code for the login just filled, the moment the page asks for it.
     *
     * The sign-in's second step: the worker remembered which login went into
     * this tab, and the first code box that appears on the same site gets that
     * login's code, worked out now so it has not turned over. Asked once per
     * box, and never over something already typed. Nothing is submitted.
     */
    const claimed = new WeakSet<HTMLInputElement>();
    const claimCode = (): void => {
        const boxes = seen.fields.oneTimeCodeBoxes
            .map((index) => at(index))
            .filter((box): box is HTMLInputElement => box !== null);
        const [first] = boxes;
        if (!first || claimed.has(first) || boxes.some((box) => box.value !== "")) return;
        claimed.add(first);
        void askBackground({ kind: "secondStepCode" }).then((reply) => {
            if (!reply.ok || !("code" in reply) || !first.isConnected) return;
            if (boxes.every((box) => box.value === "")) putCode(boxes, reply.code);
        });
    };

    /**
     * Open what a mark offers.
     *
     * `offered` is the menu opening by itself because somebody put the cursor in
     * the box, the way a password manager's list drops down under a login field.
     * That one only appears when there is something in it: a panel that says
     * "nothing saved here" every time somebody clicks into a field is one they
     * learn to swat away, and the mark is still there for the question.
     */
    const show = async (role: Role, field: HTMLInputElement, offered = false): Promise<void> => {
        if (open) return;
        open = true;
        try {
            if (role === "generate") {
                offerGenerated(field, await savedOptions(), (value) => {
                    put(field, value);
                    // And the box beside it, which is the one somebody would
                    // otherwise have to paste into from a password they cannot see.
                    const confirm = at(seen.fields.confirmPassword);
                    if (confirm && confirm !== field) put(confirm, value);
                });
                return;
            }
            const reply = await askBackground({ kind: "itemsFor", url: location.href });
            if (!reply.ok) {
                // Locked, most often. Not offered by itself - a panel that drops
                // down only to say "locked" on every click is one people learn to
                // swat - but the mark answers with why it has nothing.
                if (!offered) menu(field, [], reply.error, async () => undefined);
                return;
            }
            const items = "items" in reply ? reply.items : [];
            if (role === "code") {
                const withCode = items.filter((item) => item.totp);
                if (offered && withCode.length === 0) return;
                menu(field, withCode, "Nothing here carries a one-time code.", async (item) => {
                    const answer = await askBackground({ kind: "totpNow", id: item.id });
                    if (answer.ok && "code" in answer) putCode(codeBoxes(field), answer.code);
                });
                return;
            }
            // Nothing saved here, or a form that is making an account: what is
            // offered is what a sign-up asks for - who you are, and a password.
            const signingUp = seen.fields.purpose === "signup";
            if (offered && items.length === 0 && !signingUp) return;
            const fresh = items.length === 0 || signingUp ? await newAccount(field) : [];
            if (offered && items.length === 0 && fresh.length === 0) return;
            const logins = items.map((item) =>
                choice(item.name, [item.username, item.vault].filter(Boolean).join(" - "), () => {
                    void askBackground({ kind: "fill", id: item.id });
                })
            );
            list(field, [...logins, ...fresh], "Nothing saved for this site.");
        } finally {
            open = false;
        }
    };

    /** The boxes a code goes in, starting from the one it was asked for on: the
     *  whole row when the page splits the code one digit per box. */
    const codeBoxes = (field: HTMLInputElement): HTMLInputElement[] => {
        const boxes = seen.fields.oneTimeCodeBoxes
            .map((index) => at(index))
            .filter((box): box is HTMLInputElement => box !== null);
        return boxes.includes(field) ? boxes : [field];
    };

    // Dropped down under the box as somebody clicks or tabs into it, once per box
    // per page: closing it is an answer, and reopening it on every focus would be
    // arguing with that answer. The mark is still there for a second look.
    const offeredOn = new WeakSet<HTMLInputElement>();
    document.addEventListener(
        "focusin",
        (event) => {
            const field = event.target;
            if (!(field instanceof HTMLInputElement) || offeredOn.has(field)) return;
            for (const role of ["login", "code"] as const) {
                const held = marks.get(role);
                // The login is offered on the password box as well as the one the
                // mark sits on, because either is where somebody starts.
                const own =
                    held?.field === field ||
                    (role === "login" && field === at(seen.fields.password));
                if (!own) continue;
                offeredOn.add(field);
                void show(role, field, true);
                return;
            }
        },
        true
    );

    /**
     * What to offer on a form for an account that is not in the vault yet.
     *
     * Your own email and name, from the account this extension is signed in as,
     * into the boxes that ask for them - and a password made here, into the new
     * password box and its confirmation. Nothing is saved by this: the offer to
     * save follows the form going, the same as for anything typed by hand.
     */
    const newAccount = async (field: HTMLInputElement): Promise<Choice[]> => {
        const { fields } = seen;
        const offered: Choice[] = [];

        const reply = await askBackground({ kind: "myDetails" });
        const details = reply.ok && "details" in reply ? reply.details : null;
        const userBox = at(fields.username) ?? (field.type === "password" ? null : field);
        if (details?.email && userBox) {
            const { email, name } = details;
            offered.push(
                choice("Use my email", email, () => {
                    put(userBox, email);
                    if (name) fillName(name);
                })
            );
        } else if (details?.name && (fields.fullName !== null || fields.givenName !== null)) {
            const { name } = details;
            offered.push(choice("Use my name", name, () => fillName(name)));
        }

        const passwordBox =
            at(fields.newPassword) ?? (fields.purpose === "signup" ? at(fields.password) : null);
        if (passwordBox) {
            const options = await savedOptions();
            offered.push(
                choice("Make a password", "A strong one, for both password boxes", () =>
                    offerGenerated(passwordBox, options, (value) => {
                        put(passwordBox, value);
                        const confirm = at(fields.confirmPassword);
                        if (confirm && confirm !== passwordBox) put(confirm, value);
                    })
                )
            );
        }
        return offered;
    };

    /** Somebody's name into the boxes that ask for it, whole or in halves. Only
     *  into empty ones: what was typed by hand is theirs. */
    const fillName = (name: string): void => {
        const { fields } = seen;
        const [given = "", ...rest] = name.trim().split(/\s+/);
        const into = (box: HTMLInputElement | null, value: string): void => {
            if (box && box.value === "" && value !== "") put(box, value);
        };
        into(at(fields.fullName), name.trim());
        into(at(fields.givenName), given);
        into(at(fields.familyName), rest.join(" "));
    };

    refresh();
    // The page keeps moving: a field can be replaced, revealed, or scrolled.
    // One debounced look rather than one per mutation, because a login page
    // renders hundreds of them in a burst - and scrolling only moves what is
    // already there, so it never goes looking again.
    let settling: number | null = null;
    const again = (): void => {
        if (settling !== null) window.clearTimeout(settling);
        settling = window.setTimeout(refresh, SETTLE_MS);
    };
    new MutationObserver(again).observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    window.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place, { passive: true });

    /**
     * Hand the worker what was just typed, at the moment the form goes.
     *
     * Read from the boxes this script already knows about rather than from the
     * event, because a submit handler that has to go and find the fields is one
     * running while a framework takes the page apart around it.
     *
     * The password that counts is the new one where the form has one - somebody
     * signing up or changing theirs - and the existing one otherwise.
     */
    const submitted = (): void => {
        const { fields } = seen;
        const password = at(fields.newPassword) ?? at(fields.password);
        const username = at(fields.username)?.value ?? "";
        if (!password) {
            // The first page of a sign-in that asks for the name alone: the
            // worker keeps it for the page that asks for the password.
            if (username.trim() !== "") void askBackground({ kind: "captured", username, password: "" });
            return;
        }
        if (password.value === "") return;
        void askBackground({
            kind: "captured",
            username,
            password: password.value
        }).then((reply) => {
            // Drawn here as well as on the next load, because a sign-in that never
            // navigates - which is most of them now - has no next load.
            if (reply.ok && "offer" in reply) bar(reply.offer);
        });
    };

    // A real form going, and a button pressed on a page that submits by script.
    // Both, because either one alone misses about half the web.
    document.addEventListener("submit", submitted, true);

    // Tell the worker what kind of box the pointer is over, so the right-click
    // menu that opens on it offers what fits: a new password on a password box,
    // the code and your email on any other. Only when the kind changes - this
    // fires on every box the pointer crosses.
    let pointed: boolean | null = null;
    document.addEventListener(
        "pointerover",
        (event) => {
            const box = event.target;
            const editable =
                box instanceof HTMLTextAreaElement ||
                (box instanceof HTMLElement && box.isContentEditable) ||
                (box instanceof HTMLInputElement && !["hidden", "button", "submit", "checkbox", "radio"].includes(box.type));
            if (!editable) return;
            const password = box instanceof HTMLInputElement && box.type === "password";
            if (password === pointed) return;
            pointed = password;
            void askBackground({ kind: "menuTarget", password });
        },
        true
    );
    document.addEventListener(
        "click",
        (event) => {
            const pressed = (event.target as Element | null)?.closest?.(
                "button, input[type=submit], input[type=button], [role=button]"
            );
            if (!pressed || !looksLikeSubmit(pressed)) return;
            const box =
                at(seen.fields.newPassword) ?? at(seen.fields.password) ?? at(seen.fields.username);
            // Only a press that belongs with the login's boxes: a cookie banner's
            // button is not somebody signing in.
            if (!box || !sharesForm(pressed, box)) return;
            submitted();
        },
        true
    );
}

/**
 * Whether a button belongs with a password box.
 *
 * The form settles it where there is one. Where there is not - which is most of
 * the sign-ins written as a component rather than a form - the test is how close
 * the two are: a few levels up from the field is the panel the button lives in,
 * and anything further away is the rest of the page. The cost of being wrong in
 * the generous direction is a save offered a moment too early, so it is kept
 * tight rather than clever.
 */
const NEIGHBOURHOOD = 4;

/**
 * The buttons that sit beside a password box and do not submit anything.
 *
 * The eye that reveals what has been typed is the one that matters: it is inside
 * the field, it is pressed halfway through typing, and reading it as a submit
 * means "Save this login?" over a password somebody is still writing. An offer
 * that arrives at the wrong moment is how a person learns to dismiss the one that
 * arrives at the right one.
 */
const NOT_A_SUBMIT =
    /show|hide|reveal|toggle|mostrar|ocultar|cancel|cancela|back|atr[aá]s|close|cerrar|forgot|olvid|help|ayuda/i;

/** Whether pressing this could plausibly be somebody submitting the form. */
function looksLikeSubmit(pressed: Element): boolean {
    // A button that holds a state is a switch, not a submit.
    if (pressed.hasAttribute("aria-pressed") || pressed.hasAttribute("aria-expanded")) return false;
    const words = [
        pressed.textContent ?? "",
        pressed.getAttribute("aria-label") ?? "",
        pressed.getAttribute("title") ?? "",
        pressed.getAttribute("name") ?? "",
        pressed.id
    ]
        .join(" ")
        .toLowerCase();
    return !NOT_A_SUBMIT.test(words);
}

function sharesForm(pressed: Element, field: HTMLInputElement): boolean {
    if (field.form) return pressed.closest("form") === field.form;
    let around: Element | null = field;
    for (let step = 0; step < NEIGHBOURHOOD && around; step += 1) {
        around = around.parentElement;
        if (around?.contains(pressed)) return true;
    }
    return false;
}

/** One input, as the rules read it. Everything the DOM knows, flattened. */
function describe(field: HTMLInputElement): FieldFacts {
    const box = field.getBoundingClientRect();
    return {
        type: (field.type || "text").toLowerCase(),
        autocomplete: (field.autocomplete || "").toLowerCase(),
        words: [
            field.name,
            field.id,
            field.placeholder,
            field.title,
            field.getAttribute("aria-label") ?? "",
            field.labels?.[0]?.textContent ?? ""
        ]
            .join(" ")
            // `login_code` and `loginCode` are two words, and the rules match
            // words: `\bcode\b` never matches either as written.
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/_/g, " ")
            .toLowerCase(),
        // The DOM answers -1 for a box with no limit.
        maxLength: field.maxLength > 0 ? field.maxLength : null,
        inputMode: (field.inputMode || "").toLowerCase(),
        usable:
            !field.disabled &&
            !field.readOnly &&
            box.width >= 2 &&
            box.height >= 2 &&
            getComputedStyle(field).visibility !== "hidden",
        form: field.form
    };
}

/**
 * Put a value into a box the way a person would.
 *
 * Written through the property descriptor and then announced: a form built with a
 * framework holds its own copy of what it believes the field says, so a value
 * assigned straight to `value` is one the page never learns about and discards on
 * submit. The same reasoning, and the same lines, as `typeIntoPage` in the worker.
 */
function put(field: HTMLInputElement, value: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    field.focus();
    descriptor?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Type a code into its box, or one digit into each box of a split one.
 *
 * Per box because a split code's boxes each listen for their own character and
 * move the cursor on by themselves; the whole code written into the first one is
 * cut to its first digit and leaves the rest empty.
 */
function putCode(boxes: readonly HTMLInputElement[], code: string): void {
    if (boxes.length <= 1) {
        const [only] = boxes;
        if (only) put(only, code);
        return;
    }
    for (const [index, box] of boxes.entries()) put(box, code.charAt(index));
}

/** The mark that sits in the corner of a box Polaris has something for. */
function mark(role: Role, onPress: () => void): HTMLElement {
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;z-index:2147483646;width:${MARK}px;height:${MARK}px;`;
    const shadow = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.type = "button";
    button.title = TITLES[role];
    button.setAttribute("aria-label", TITLES[role]);
    button.textContent = "P";
    button.style.cssText = `
        width: ${MARK}px;
        height: ${MARK}px;
        border: 0;
        border-radius: 5px;
        cursor: pointer;
        font: 600 11px ui-sans-serif, system-ui, sans-serif;
        color: #fff;
        background: ${BRAND};
    `;
    button.addEventListener("mousedown", (event) => {
        // The field must not lose focus to the mark: a page that fills on blur
        // would act on an empty box.
        event.preventDefault();
        onPress();
    });
    shadow.append(button);
    document.body.append(host);
    return host;
}

/** The panel every menu below is drawn inside: ours, under the field, in a shadow
 *  root the page cannot reach into. */
function floating(field: HTMLInputElement): {
    host: HTMLElement;
    panel: HTMLElement;
    close: () => void;
} {
    const host = document.createElement("div");
    const box = field.getBoundingClientRect();
    host.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        top: ${box.bottom + 4}px;
        left: ${box.left}px;
        width: ${Math.max(240, Math.min(340, box.width))}px;
    `;
    const shadow = host.attachShadow({ mode: "closed" });
    const panel = document.createElement("div");
    panel.style.cssText = `
        border: 1px solid hsl(225 10% 16%);
        border-radius: 8px;
        overflow: hidden;
        background: hsl(225 11% 9%);
        color: hsl(220 14% 96%);
        font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
        box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
    `;

    const close = (): void => {
        host.remove();
        document.removeEventListener("mousedown", away, true);
        document.removeEventListener("keydown", onKey, true);
        field.removeEventListener("blur", close);
    };
    const away = (event: Event): void => {
        if (!host.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
        if (event.key === "Escape") close();
    };

    shadow.append(panel);
    document.body.append(host);
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", onKey, true);
    // Tabbing on to the next box leaves the list behind: pressing inside the
    // panel never blurs the field, because every button in it cancels mousedown.
    field.addEventListener("blur", close);
    return { host, panel, close };
}

/** A button in one of our panels, drawn the same way everywhere. */
function action(label: string, onPress: () => void, primary = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = `
        border: 1px solid ${primary ? BRAND : "hsl(225 10% 20%)"};
        border-radius: 6px;
        padding: 5px 10px;
        cursor: pointer;
        font: inherit;
        color: ${primary ? "#fff" : "hsl(220 14% 96%)"};
        background: ${primary ? BRAND : "transparent"};
    `;
    button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        onPress();
    });
    return button;
}

/** The chooser: the logins for this page, or the ones carrying a code. */
/** One row in a chooser: what it is, a line under it, and what pressing it does. */
interface Choice {
    readonly label: string;
    readonly detail: string;
    readonly pick: () => void;
}

function choice(label: string, detail: string, pick: () => void): Choice {
    return { label, detail, pick };
}

function menu(
    field: HTMLInputElement,
    items: readonly ItemSummary[],
    empty: string,
    onChoose: (item: ItemSummary) => Promise<void>
): void {
    list(
        field,
        items.map((item) =>
            choice(item.name, [item.username, item.vault].filter(Boolean).join(" - "), () => {
                void onChoose(item);
            })
        ),
        empty
    );
}

/** A chooser under a field, drawn from rows. */
function list(field: HTMLInputElement, items: readonly Choice[], empty: string): void {
    const { panel, close } = floating(field);

    if (items.length === 0) {
        const nothing = document.createElement("p");
        nothing.textContent = empty;
        nothing.style.cssText = "margin:0;padding:10px 12px;color:hsl(222 10% 66%);";
        panel.append(nothing);
        return;
    }

    for (const item of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.style.cssText = `
            display: block;
            width: 100%;
            border: 0;
            background: transparent;
            color: inherit;
            font: inherit;
            text-align: left;
            padding: 8px 12px;
            cursor: pointer;
        `;
        const name = document.createElement("span");
        name.textContent = item.label;
        name.style.cssText = "display:block;";
        const who = document.createElement("span");
        who.textContent = item.detail;
        who.style.cssText = "display:block;font-size:12px;color:hsl(222 10% 66%);";
        row.append(name, who);
        row.addEventListener("mouseenter", () => {
            row.style.background = "hsl(225 12% 13%)";
        });
        row.addEventListener("mouseleave", () => {
            row.style.background = "transparent";
        });
        row.addEventListener("mousedown", (event) => {
            event.preventDefault();
            close();
            item.pick();
        });
        panel.append(row);
    }
}

/**
 * What the popup's generator was last told to make, so a password made on the
 * page honours the same choices - a site that refuses symbols is told once.
 *
 * Read straight from extension storage, which a script inside a page can do
 * without asking the worker for anything: these are choices, not a secret, and a
 * new message a page could send would be one more thing to reason about. The
 * defaults when there is nothing saved or storage will not answer.
 */
async function savedOptions(): Promise<GeneratorOptions> {
    try {
        return readGeneratorOptions(await storage.getItem<unknown>(GENERATOR_KEY));
    } catch {
        return GENERATOR_DEFAULTS;
    }
}

/**
 * A password to use, on the box one is being invented in.
 *
 * Made here rather than in the worker: the generator is pure, it needs no key and
 * no network, and a password that never leaves this page is one fewer thing
 * crossing a boundary. It is `@polaris/core`'s, so a password made here and one
 * made in the popup are drawn the same way, from the same saved choices - see that
 * module for why the obvious way of picking characters is biased.
 *
 * Nothing is saved by this. What makes it into the vault is the offer that
 * follows the form being submitted, which is the same path a password somebody
 * typed themselves takes.
 */
function offerGenerated(
    field: HTMLInputElement,
    options: GeneratorOptions,
    use: (value: string) => void
): void {
    const { panel, close } = floating(field);
    let value = generatePassword(options);

    const shown = document.createElement("code");
    shown.style.cssText = `
        display: block;
        padding: 10px 12px;
        font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        word-break: break-all;
        color: hsl(220 14% 96%);
    `;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;padding:0 12px 10px;";

    const draw = (): void => {
        shown.textContent = value ?? "Nothing can be made of that.";
    };
    draw();

    row.append(
        action(
            "Use it",
            () => {
                if (!value) return;
                use(value);
                close();
            },
            true
        ),
        action("Again", () => {
            value = generatePassword(options);
            draw();
        })
    );
    panel.append(shown, row);
}

/**
 * Say so when the password somebody is typing is already public.
 *
 * On the box a new password goes in, and nowhere else: a sign-in box is the
 * password they already have, and telling them it is breached at the moment they
 * are trying to get in is a warning with nothing to do about it. Here there is -
 * they are choosing one right now, and the mark beside the box will make another.
 *
 * The password goes to the worker and no further; what leaves the browser is five
 * characters of its hash, to Polaris's own server. An unknown answer says
 * nothing, because a warning nobody can act on is worse than silence.
 */
let watching: HTMLInputElement | null = null;
let warning: HTMLElement | null = null;
let asking: number | null = null;

function watchForBreaches(field: HTMLInputElement | null): void {
    if (field === watching) return;
    watching = field;
    warning?.remove();
    warning = null;
    if (!field) return;

    field.addEventListener("input", () => {
        if (asking !== null) window.clearTimeout(asking);
        warning?.remove();
        warning = null;
        const typed = field.value;
        asking = window.setTimeout(() => {
            void askBackground({ kind: "breach", password: typed }).then((reply) => {
                if (!reply.ok || !("count" in reply)) return;
                // Still the same password, and still on screen: a warning that
                // lands after somebody has moved on is one about nothing.
                if (field.value !== typed || (reply.count ?? 0) === 0) return;
                warning = note(field, reply.count ?? 0);
            });
        }, BREACH_AFTER_MS);
    });
}

/** The line under a password box that has turned up in a breach. */
function note(field: HTMLInputElement, count: number): HTMLElement {
    const box = field.getBoundingClientRect();
    const host = document.createElement("div");
    host.style.cssText = `
        position: fixed;
        z-index: 2147483645;
        top: ${box.bottom + 4}px;
        left: ${box.left}px;
        width: ${Math.max(240, Math.min(360, box.width))}px;
    `;
    const shadow = host.attachShadow({ mode: "closed" });
    const line = document.createElement("p");
    line.textContent =
        count === 1
            ? "This password has appeared in a data breach. Pick a different one."
            : `This password has appeared in ${count.toLocaleString()} breaches. Pick a different one.`;
    line.style.cssText = `
        margin: 0;
        border: 1px solid hsl(0 60% 30%);
        border-radius: 8px;
        padding: 8px 10px;
        background: hsl(0 40% 12%);
        color: hsl(0 80% 88%);
        font: 12px/1.4 ui-sans-serif, system-ui, sans-serif;
    `;
    shadow.append(line);
    document.body.append(host);
    return host;
}

/** Whatever the worker is still holding for this page, drawn if there is any. */
async function offerHeld(): Promise<void> {
    const reply = await askBackground({ kind: "pendingCapture" });
    if (reply.ok && "offer" in reply) bar(reply.offer);
}

/** The bar in the corner is drawn once at a time, however many forms a page has. */
let barHost: HTMLElement | null = null;

/**
 * "Save this login?", in the corner, after a form has gone.
 *
 * It names what would happen rather than asking a general question: saving a new
 * login and replacing the password on one that exists are different enough that
 * somebody should be able to tell which they are agreeing to without opening
 * anything.
 *
 * Nothing about the login crosses back to say yes. The worker has been holding
 * the values since the form went, and this sends a word.
 */
function bar(offer: OfferedCapture): void {
    if (offer.kind === "none") return;
    barHost?.remove();

    const host = document.createElement("div");
    barHost = host;
    host.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        right: 16px;
        bottom: 16px;
        width: 320px;
    `;
    const shadow = host.attachShadow({ mode: "closed" });
    const panel = document.createElement("div");
    // Named, because a bar that appears in the corner of somebody else's site
    // has to say whose it is to a reader who cannot see the violet.
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "Polaris");
    panel.style.cssText = `
        border: 1px solid hsl(225 10% 16%);
        border-radius: 10px;
        padding: 12px;
        background: hsl(225 11% 9%);
        color: hsl(220 14% 96%);
        font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
        box-shadow: 0 10px 30px rgb(0 0 0 / 0.45);
    `;

    const close = (): void => {
        host.remove();
        if (barHost === host) barHost = null;
    };

    const title = document.createElement("p");
    title.style.cssText = "margin:0 0 2px;font-weight:600;";
    title.textContent =
        offer.kind === "update"
            ? `Update the password saved for ${offer.name ?? "this login"}?`
            : "Save this login in Polaris?";

    const who = document.createElement("p");
    who.style.cssText = "margin:0 0 10px;color:hsl(222 10% 66%);word-break:break-all;";
    who.textContent = [offer.username, offer.kind === "save" ? offer.name : null]
        .filter(Boolean)
        .join(" - ");

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
    row.append(
        action(
            offer.kind === "update" ? "Update" : "Save",
            () => {
                void askBackground({ kind: "saveCaptured" }).then((reply) => {
                    if (reply.ok) {
                        close();
                        return;
                    }
                    // The one place a refusal is worth showing: somebody pressed a
                    // button and nothing happened otherwise. It keeps a way out -
                    // a bar that says why it failed and cannot be closed is worse
                    // than the failure.
                    title.textContent = "error" in reply ? reply.error : "That could not be saved.";
                    who.remove();
                    row.replaceChildren(action("Close", close));
                });
            },
            true
        ),
        action("Not now", () => {
            void askBackground({ kind: "dismissCapture", never: false });
            close();
        }),
        action("Never here", () => {
            void askBackground({ kind: "dismissCapture", never: true });
            close();
        })
    );

    panel.append(title, who, row);
    shadow.append(panel);
    document.body.append(host);
}
