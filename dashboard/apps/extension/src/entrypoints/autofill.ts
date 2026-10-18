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
 * Picking a login is the one thing that submits: it is asking to be signed in,
 * so the worker presses each step's button as it fills it, and the steps a site
 * puts after it - the password page, the code page - are filled and submitted
 * as they appear. Generating a password and offering to save one submit nothing.
 */

import { storage } from "#imports";
import { generatePassword } from "@polaris/core/password-generator";
import {
    GENERATOR_DEFAULTS,
    GENERATOR_KEY,
    readGeneratorOptions,
    type GeneratorOptions
} from "@/lib/generator";
import { emptyProfile, PROFILE_PARTS, readForm, type PageFields } from "@/lib/fields";
import { wholeName } from "@/lib/identity";
import { enterSendsLogin } from "@/lib/enter-submit";
import {
    describeInput,
    frameOffset,
    isInput,
    scanInputs,
    upFrom,
    type ShadowOpener
} from "@/lib/page-scan";
import { CLIPBOARD_CLEAR_MS } from "@/lib/generator";
import {
    askBackground,
    speakRepliesIn,
    type IdentityValues,
    type ItemSummary,
    type OfferedCapture
} from "@/lib/messages";
import { words } from "@/lib/locale-store";
import { ENGLISH, type Words } from "@/lib/words";

/** How long to wait for a page to stop changing before looking again. Logins
 *  arrive late on most sites now - a form is rendered after the framework has
 *  fetched something - so one look at load would miss them. */
const SETTLE_MS = 400;

/** How long after the last keystroke a password is asked about. Long enough that
 *  typing one does not make a request per character. */
const BREACH_AFTER_MS = 800;

/** How long after a button press a login box disappearing is read as the
 *  login being sent. A sign-in that posts with `fetch` and swaps the page for
 *  what comes back fires no submit and no navigation; the boxes going away is
 *  all there is to see. Without a press just before it, a box going away is
 *  somebody changing their mind. */
const GONE_AFTER_PRESS_MS = 10_000;

/** When the clipboard holding a password copied from a page is to be emptied:
 *  a time, never the value, in storage a page's script can read, so the next
 *  page this runs on finishes the job if this one is gone by then. */
const CLIPBOARD_CLEAR_KEY = "local:inline.clipboardClearAt";
/** How long past its deadline a clipboard is still worth emptying: a browser
 *  that refuses every write without a press would otherwise be asked forever. */
const CLIPBOARD_GIVE_UP_MS = 10 * 60_000;

/** The closed shadow roots Chrome hands an extension; nothing elsewhere. */
const opener: ShadowOpener | undefined = (() => {
    const dom = (
        globalThis as {
            chrome?: { dom?: { openOrClosedShadowRoot?: (element: Element) => ShadowRoot | null } };
        }
    ).chrome?.dom;
    const open = dom?.openOrClosedShadowRoot;
    return open ? (element: Element) => open.call(dom, element) : undefined;
})();

/** The element an event really happened on: inside a shadow root, the event
 *  seen at the document names the root's host instead. */
function origin(event: Event): EventTarget | null {
    return event.composedPath()[0] ?? event.target;
}

/** The mark's size, and the room it needs at the right edge of a field. */
const MARK = 18;

/** Polaris's own violet, which is what makes the mark recognisable as ours on a
 *  page that knows nothing about it. */
const BRAND = "hsl(258 82% 62%)";

/** The three things a mark can be for. */
type Role = "login" | "generate" | "code";

/** Every one of them, to walk in a fixed order. */
const ROLES = ["login", "generate", "code"] as const satisfies readonly Role[];

/** The words this page is spoken to in: the account's language, read once when
 *  the script starts, and English until then. */
let t: Words = ENGLISH;

/** What each mark says it is for, before anything is opened. */
function markTitle(role: Role): string {
    return t(`inline.marks.${role}`);
}

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
    t = await words().catch(() => ENGLISH);
    speakRepliesIn(t);
    // Two questions the page must not decide: whether this site was switched
    // off, and whether there is an open vault to offer anything from. Both are
    // the worker's, and both are re-asked whenever a menu opens rather than
    // cached here - a vault that locks while a tab sits open must stop offering.
    const here = await askBackground({ kind: "blocked" });
    if (!here.ok || !("blocked" in here) || here.blocked) return;

    // A login submitted on the page before this one. Asked for first, because the
    // navigation that submitting caused is what loaded this script, and the offer
    // is the whole reason anybody typed anything.
    void offerHeld(() => recapture());
    void finishClearing();

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
            profile: emptyProfile(),
            usernameAsks: null,
            purpose: "none"
        },
        inputs: []
    };

    // The page keeps moving: a field can be replaced, revealed, or scrolled.
    // One look per burst rather than one per mutation, because a login page
    // renders hundreds of them at once - and scrolling only moves what is
    // already there, so it never goes looking again.
    //
    // Revealed counts as much as added. A sign-in that has its password box in
    // the page from the start and shows it on the next step changes a style or
    // a class and adds nothing, and watching for new nodes alone slept straight
    // through the step it was waiting for. And the look is taken a fixed time
    // after the first change rather than after the last: a page with a spinner
    // or a clock on it never stops changing, and a wait for quiet on one of
    // those never ends.
    let settling: number | null = null;
    const again = (): void => {
        if (settling !== null) return;
        settling = window.setTimeout(() => {
            settling = null;
            refresh();
        }, SETTLE_MS);
    };
    const observer = new MutationObserver((records) => {
        if (!onlyOurs(records)) again();
    });
    const WATCH: MutationObserverInit = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden", "aria-hidden", "disabled", "type"]
    };

    /** A shadow root or a frame met for the first time: watched for changes,
     *  which the observer on the document never sees inside either, and listened
     *  to for what does not cross into the document - a submit never leaves a
     *  shadow root, and nothing at all leaves a frame. */
    const trees = new WeakSet<Node>();
    const watchTree = (tree: Document | ShadowRoot): void => {
        if (trees.has(tree)) return;
        trees.add(tree);
        observer.observe(tree, WATCH);
        tree.addEventListener("submit", submitted, true);
        if (tree.nodeType === Node.DOCUMENT_NODE) listenIn(tree as Document);
    };

    const frames = new WeakSet<HTMLIFrameElement>();
    const watchFrame = (frame: HTMLIFrameElement): void => {
        if (frames.has(frame)) return;
        frames.add(frame);
        frame.addEventListener("load", again);
    };

    const look = (): void => {
        const scan = scanInputs(document, opener);
        seen = { fields: readForm(scan.inputs.map(describeInput)), inputs: scan.inputs };
        for (const tree of scan.trees) watchTree(tree);
        for (const frame of scan.frames) watchFrame(frame);
    };

    /** A box on the top page itself. A login is filled by the worker into the top
     *  page only, so a box inside a frame is offered nothing that needs it. */
    const onTop = (box: HTMLInputElement | null): HTMLInputElement | null =>
        box && box.ownerDocument === document ? box : null;

    const at = (index: number | null): HTMLInputElement | null =>
        index === null ? null : (seen.inputs[index] ?? null);

    /** Move the marks to where their boxes are now. Called on every scroll, so it
     *  touches the DOM and nothing else. */
    const place = (): void => {
        for (const { field, host } of marks.values()) {
            const box = field.getBoundingClientRect();
            const shift = frameOffset(field);
            // Fixed rather than absolute: a field inside a scrolling panel moves
            // without the document scrolling, and `position: absolute` would leave
            // the mark behind on the page.
            host.style.top = `${shift.y + box.top + (box.height - MARK) / 2}px`;
            host.style.left = `${shift.x + box.right - MARK - 6}px`;
            host.style.display = box.width < 60 || box.height < 16 ? "none" : "block";
        }
    };

    /** Look again at what the page is asking for, and put a mark on each box that
     *  Polaris has something to offer for. */
    const refresh = (): void => {
        look();
        const { fields } = seen;
        noticeGone();
        // The login mark sits on the name where there is one and on the password
        // otherwise, because that is where somebody's eye already is.
        const wanted: Record<Role, HTMLInputElement | null> = {
            login: onTop(at(fields.username) ?? at(fields.password)),
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
        claimPassword();
        claimCode();
    };

    /**
     * Type the password for the login picked on the page before, the moment the
     * page asks for it.
     *
     * A sign-in that asks for the name alone and the password next: somebody
     * picked a login on the first page, and picking it again on the second was
     * a step for nothing. The worker remembered the pick for this tab and site
     * and fills it itself, so nothing about the login crosses to this script.
     * Asked once per box, and never over something already typed.
     */
    const passwordAsked = new WeakSet<HTMLInputElement>();
    const claimPassword = (): void => {
        const box = onTop(at(seen.fields.password));
        if (!box || passwordAsked.has(box) || box.value !== "") return;
        passwordAsked.add(box);
        // The fill puts the cursor in the box as it types, and the list must not
        // drop down there to offer what is being typed.
        const offered = offeredOn.has(box);
        offeredOn.add(box);
        void askBackground({ kind: "continueSignIn" }).then((reply) => {
            if (reply.ok) dismiss();
            else if (!offered) offeredOn.delete(box);
        });
    };

    /**
     * Have the code typed for the login just filled, the moment the page asks
     * for it.
     *
     * The sign-in's last step: the worker remembered which login went into this
     * tab, and the first code box that appears on the same site gets that
     * login's code, worked out and typed by the worker - so the code never
     * passes through this script - and submitted, like the steps before it.
     * Asked once per box, and never over something already typed.
     */
    const claimed = new WeakSet<HTMLInputElement>();
    const claimCode = (): void => {
        const boxes = seen.fields.oneTimeCodeBoxes
            .map((index) => at(index))
            .filter((box): box is HTMLInputElement => box !== null);
        const [first] = boxes;
        if (
            !onTop(first ?? null) ||
            !first ||
            claimed.has(first) ||
            boxes.some((box) => box.value !== "")
        )
            return;
        claimed.add(first);
        const fresh = boxes.filter((box) => !offeredOn.has(box));
        for (const box of fresh) offeredOn.add(box);
        void askBackground({ kind: "secondStepCode" }).then((reply) => {
            // A list that dropped down on the box while the code was on its way
            // is offering what has just been typed.
            if (reply.ok) dismiss();
            else for (const box of fresh) offeredOn.delete(box);
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
                    keep(value);
                });
                return;
            }
            const before = field.value;
            const reply = await askBackground({ kind: "itemsFor", url: location.href });
            // Dropped down by itself on a box that has been filled since - by the
            // login picked a moment ago, which puts the cursor in each box it
            // types into - or that somebody has already left: offering the list
            // there is asking again for what was just answered.
            if (offered && (field.value !== before || document.activeElement !== field)) return;
            if (!reply.ok) {
                // Locked, most often. Not offered by itself - a panel that drops
                // down only to say "locked" on every click is one people learn to
                // swat - but the mark answers with why it has nothing, and with
                // the way to unlock when that is why.
                if (offered) return;
                if ("locked" in reply && reply.locked) {
                    list(
                        field,
                        [
                            choice(t("inline.unlock"), reply.error, () => {
                                void askBackground({ kind: "openUnlock" });
                            })
                        ],
                        reply.error
                    );
                    return;
                }
                menu(field, [], reply.error, async () => undefined);
                return;
            }
            const items = "items" in reply ? reply.items : [];
            if (role === "code") {
                const withCode = items.filter((item) => item.totp);
                if (offered && withCode.length === 0) return;
                menu(field, withCode, t("inline.noCodes"), async (item) => {
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
                    // The boxes this fill types into are answered: the list is
                    // not to drop down again on the password box as the fill
                    // passes through it.
                    for (const index of [seen.fields.username, seen.fields.password]) {
                        const box = at(index);
                        if (box) offeredOn.add(box);
                    }
                    void askBackground({ kind: "fill", id: item.id });
                })
            );
            list(field, [...logins, ...fresh], t("inline.nothingSaved"));
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
            const field = origin(event);
            if (!isInput(field) || offeredOn.has(field)) return;
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
     * The identities of the open shelf, its default first - who you are, typed
     * into the boxes that ask for it - and a password made here, into the new
     * password box and its confirmation. Only the names travel to the page
     * when the menu opens; the identity itself crosses once it is picked.
     * Nothing is saved by this: the offer to save follows the form going.
     */
    const newAccount = async (field: HTMLInputElement): Promise<Choice[]> => {
        const { fields } = seen;
        const offered: Choice[] = [];

        const reply = await askBackground({ kind: "identities" });
        const cards = reply.ok && "identities" in reply ? reply.identities : [];
        for (const card of cards) {
            const detail = [card.detail, card.isDefault ? t("inline.identityDefault") : card.vault]
                .filter(Boolean)
                .join(" - ");
            offered.push(
                choice(card.name, detail, () => {
                    void askBackground({ kind: "identity", id: card.id }).then((answer) => {
                        if (answer.ok && "identity" in answer) fillIdentity(answer.identity, field);
                    });
                })
            );
        }

        const passwordBox =
            at(fields.newPassword) ?? (fields.purpose === "signup" ? at(fields.password) : null);
        if (passwordBox) {
            const options = await savedOptions();
            offered.push(
                choice(t("inline.makePassword"), t("inline.makePasswordDetail"), () =>
                    offerGenerated(passwordBox, options, (value) => {
                        put(passwordBox, value);
                        const confirm = at(fields.confirmPassword);
                        if (confirm && confirm !== passwordBox) put(confirm, value);
                        keep(value);
                    })
                )
            );
        }
        return offered;
    };

    /**
     * An identity into the boxes that ask for it. Only into empty ones, and the
     * box the menu was opened on: what was typed by hand elsewhere is theirs.
     */
    const fillIdentity = (values: IdentityValues, field: HTMLInputElement): void => {
        const { fields } = seen;
        const into = (box: HTMLInputElement | null, value: string): void => {
            if (box && value !== "" && (box.value === "" || box === field)) put(box, value);
        };
        // The username box asks for whatever the page says it does; a box that
        // says nothing is, on a sign-up, most often an email.
        const login =
            fields.usernameAsks === "phone"
                ? values.phone
                : fields.usernameAsks === "username"
                  ? values.username || values.email
                  : values.email || values.username;
        into(at(fields.username), login);
        const whole = wholeName(values);
        into(at(fields.fullName), whole);
        into(at(fields.givenName), values.firstName);
        into(at(fields.familyName), values.lastName);
        for (const part of PROFILE_PARTS) into(at(fields.profile[part]), values[part]);
    };

    observer.observe(document.documentElement, WATCH);
    window.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place, { passive: true });
    // A single-page app moving on changes the address without loading anything,
    // which is often the only sign a sign-in went through.
    window.addEventListener("popstate", again);
    window.addEventListener("hashchange", again);

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
    /** The last pair handed over, so a form reported by its button, its submit
     *  and its disappearance is offered once rather than three times. */
    let sent = "";
    const send = (username: string, password: string, newAccount: boolean): void => {
        const key = `${username}\u0000${password}`;
        if (key === sent) return;
        sent = key;
        void askBackground({ kind: "captured", username, password, newAccount }).then((reply) => {
            // Drawn here as well as on the next load, because a sign-in that
            // never navigates - which is most of them now - has no next load.
            if (reply.ok && "offer" in reply) bar(reply.offer, () => recapture());
        });
    };

    /** Whether the form in front of somebody is making an account. */
    const makingAccount = (): boolean => seen.fields.purpose === "signup";

    const submitted = (): void => {
        const { fields } = seen;
        const password = at(fields.newPassword) ?? at(fields.password);
        const username = at(fields.username)?.value ?? "";
        if (!password) {
            // The first page of a sign-in that asks for the name alone: the
            // worker keeps it for the page that asks for the password.
            if (username.trim() !== "")
                void askBackground({ kind: "captured", username, password: "" });
            return;
        }
        if (password.value === "") return;
        typed = null;
        send(username, password.value, makingAccount());
    };

    /**
     * A password generated on the page, offered for saving the moment it is used.
     *
     * Held by the worker for the tab, like a submitted login - so it is still on
     * offer on the page the form lands on, and the form submitting later only
     * brings the username up to date. Under the username already typed: the
     * worker decides between a new login and the existing one for this site and
     * that username.
     */
    const keep = (value: string): void => {
        send(at(seen.fields.username)?.value ?? "", value, seen.fields.purpose !== "change");
    };

    /** Before saving from the bar: what the form says now, which may have a
     *  username typed after the password was generated. */
    const recapture = async (): Promise<void> => {
        if (sent === "") return;
        const password = at(seen.fields.newPassword) ?? at(seen.fields.password);
        if (!password || password.value === "" || !password.isConnected) return;
        const username = at(seen.fields.username)?.value ?? "";
        const key = `${username}\u0000${password.value}`;
        if (key === sent) return;
        sent = key;
        await askBackground({
            kind: "captured",
            username,
            password: password.value,
            newAccount: makingAccount()
        });
    };

    /**
     * The login somebody has typed so far, kept for the moment the form goes
     * without saying so: a sign-in posted with `fetch` that swaps the boxes for
     * what came back, or moves the address on, fires no submit at all.
     */
    let typed: { username: string; password: string; newAccount: boolean } | null = null;
    let pressedAt = 0;
    const remember = (event: Event): void => {
        const box = origin(event);
        const { fields } = seen;
        const password = at(fields.newPassword) ?? at(fields.password);
        const user = at(fields.username);
        if (!password || (box !== password && box !== user)) return;
        if (password.value === "") return;
        typed = {
            username: user?.value ?? typed?.username ?? "",
            password: password.value,
            newAccount: makingAccount()
        };
    };

    /** The boxes gone, or the address moved on, right after a press: the login
     *  was sent. Called on every look. */
    const noticeGone = (): void => {
        if (!typed) return;
        const held = typed;
        const still = [at(seen.fields.newPassword), at(seen.fields.password)].some(
            (box) => box !== null && box.isConnected && box.value === held.password
        );
        if (still) return;
        if (Date.now() - pressedAt > GONE_AFTER_PRESS_MS) return;
        typed = null;
        send(held.username, held.password, held.newAccount);
    };

    // The page going away right after a press - `location.assign` once a script
    // has posted the login - is the last moment to hand it over.
    window.addEventListener("pagehide", () => {
        if (typed && Date.now() - pressedAt <= GONE_AFTER_PRESS_MS) {
            const held = typed;
            typed = null;
            send(held.username, held.password, held.newAccount);
        }
    });

    // A real form going, and a button pressed on a page that submits by script.
    // Both, because either one alone misses about half the web.
    document.addEventListener("submit", submitted, true);

    // Tell the worker what kind of box the pointer is over, so the right-click
    // menu that opens on it offers what fits: a new password on a password box,
    // the code and your email on any other. The menu is one for the whole
    // browser, so every box entered reports, and the worker skips a kind it has
    // already applied.
    document.addEventListener(
        "pointerover",
        (event) => {
            const box = event.target;
            const editable =
                box instanceof HTMLTextAreaElement ||
                (box instanceof HTMLElement && box.isContentEditable) ||
                (box instanceof HTMLInputElement &&
                    !["hidden", "button", "submit", "checkbox", "radio"].includes(box.type));
            if (!editable) return;
            const password = box instanceof HTMLInputElement && box.type === "password";
            void askBackground({ kind: "menuTarget", password });
        },
        true
    );
    const onClick = (event: Event): void => {
        const target = origin(event) as Element | null;
        const pressed = target?.closest?.(PRESSABLE);
        if (!pressed || !looksLikeSubmit(pressed) || !mayBeSubmit(pressed, target)) return;
        const box =
            at(seen.fields.newPassword) ?? at(seen.fields.password) ?? at(seen.fields.username);
        if (!box) return;
        // Remembered either way: a press the boxes then disappear after is a
        // login sent from a button this could not tie to them.
        pressedAt = Date.now();
        // Only a press that belongs with the login's boxes: a cookie banner's
        // button is not somebody signing in.
        if (pressed.nodeName === "A" || !pressed.matches(BUTTON) || !sharesForm(pressed, box))
            return;
        submitted();
    };
    // Enter in a login box that no form submits, which neither of the two
    // above ever sees.
    const onKey = (event: KeyboardEvent): void => {
        const { fields } = seen;
        const boxes = [fields.newPassword, fields.password, fields.username].map(at);
        const sending = {
            key: event.key,
            isComposing: event.isComposing,
            repeat: event.repeat,
            target: origin(event)
        };
        if (sending.key === "Enter" && boxes.includes(sending.target as HTMLInputElement))
            pressedAt = Date.now();
        if (enterSendsLogin(sending, boxes)) submitted();
    };

    /** Every listener a document needs: the top page's, and each same-origin
     *  frame's, since no event leaves a frame. */
    function listenIn(doc: Document): void {
        doc.addEventListener("click", onClick, true);
        doc.addEventListener("keydown", onKey, true);
        doc.addEventListener("input", remember, true);
        if (doc !== document)
            doc.addEventListener("scroll", place, { passive: true, capture: true });
    }
    listenIn(document);

    refresh();
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

/** What submits a form: the only presses read as the login being sent. */
const BUTTON = "button, input[type=submit], input[type=button], input[type=image], [role=button]";

/** What a page submits from by script as well: a press on one of these only
 *  arms the wait for the boxes to go. */
const PRESSABLE = `${BUTTON}, a, [onclick], [tabindex]`;

/** What is pressed to type into or to tick, never to send. */
const CONTROL =
    "input, select, textarea, label, [contenteditable]:not([contenteditable=false]), " +
    "[role=checkbox], [role=radio], [role=switch], [role=textbox], [role=combobox], " +
    "[role=searchbox], [role=listbox], [role=option], [role=tab], [role=slider], [role=spinbutton]";

/** Whether a press is on something that could send a form at all: not a box,
 *  a checkbox or a link that leaves for another page. */
function mayBeSubmit(pressed: Element, target: Element | null): boolean {
    const control = target?.closest?.(CONTROL);
    if (control && pressed.contains(control) && !control.matches(BUTTON)) return false;
    if (pressed.nodeName !== "A") return true;
    const href = (pressed.getAttribute("href") ?? "").trim().toLowerCase();
    return href === "" || href.startsWith("#") || href.startsWith("javascript:");
}

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
    // Up through shadow roots as well: a component's button and its input are
    // often in different ones.
    const above = new Set<Node>();
    for (let node: Node | null = pressed; node; node = upFrom(node)) above.add(node);
    let around: Node | null = field;
    for (let step = 0; step < NEIGHBOURHOOD && around; step += 1) {
        around = upFrom(around);
        if (around && around.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && above.has(around))
            return true;
    }
    return false;
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
    // The setter of the box's own window: a box inside a frame belongs to that
    // frame's copy of `HTMLInputElement`.
    const kind =
        (field.ownerDocument.defaultView as (Window & typeof globalThis) | null)
            ?.HTMLInputElement ?? HTMLInputElement;
    const descriptor = Object.getOwnPropertyDescriptor(kind.prototype, "value");
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

/**
 * Everything this script puts on the page, so watching the page for changes can
 * leave its own out: a mark is moved by setting its style on every scroll, and a
 * look taken for each of those would move the marks again, forever.
 */
const drawn = new WeakSet<Node>();

/** A host for something of ours on the page, remembered as ours. */
function ourHost(): HTMLElement {
    const host = document.createElement("div");
    drawn.add(host);
    return host;
}

/** Whether a change the page made is only one of ours moving or appearing. */
function onlyOurs(records: readonly MutationRecord[]): boolean {
    return records.every(
        (record) =>
            drawn.has(record.target) ||
            (record.type === "childList" &&
                [...record.addedNodes, ...record.removedNodes].every((node) => drawn.has(node)))
    );
}

/** The mark that sits in the corner of a box Polaris has something for. */
function mark(role: Role, onPress: () => void): HTMLElement {
    const host = ourHost();
    host.style.cssText = `position:fixed;z-index:2147483646;width:${MARK}px;height:${MARK}px;`;
    const shadow = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.type = "button";
    button.title = markTitle(role);
    button.setAttribute("aria-label", markTitle(role));
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

/** The panel open under a field right now, closed by whatever makes it moot. */
let floatingClose: (() => void) | null = null;

/** Close the panel under a field, if one is open: what it offered has just been
 *  typed without it. */
function dismiss(): void {
    floatingClose?.();
}

/** The panel every menu below is drawn inside: ours, under the field, in a shadow
 *  root the page cannot reach into. One at a time. */
function floating(field: HTMLInputElement): {
    host: HTMLElement;
    panel: HTMLElement;
    close: () => void;
} {
    const host = ourHost();
    const box = field.getBoundingClientRect();
    const shift = frameOffset(field);
    host.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        top: ${shift.y + box.bottom + 4}px;
        left: ${shift.x + box.left}px;
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
        if (floatingClose === close) floatingClose = null;
    };
    floatingClose?.();
    floatingClose = close;
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
        shown.textContent = value ?? t("generator.nothing");
    };
    draw();

    // What copying did, said under the buttons: a copy with no answer is one
    // somebody presses three times to be sure.
    const said = document.createElement("p");
    said.setAttribute("role", "status");
    said.style.cssText = "margin:0;padding:0 12px 10px;font-size:12px;color:hsl(222 10% 66%);";

    const copy = action(t("generator.copy"), () => {
        if (!value) return;
        const copied = value;
        void copyText(copied, panel).then((done) => {
            if (!done) {
                said.textContent = t("popup.clipboard.refused");
                return;
            }
            copy.textContent = t("generator.copied");
            said.textContent = t("inline.copiedClears", {
                seconds: CLIPBOARD_CLEAR_MS / 1000
            });
            clearClipboardLater();
        });
    });
    copy.title = t("generator.copyPassword");

    row.append(
        action(
            t("generator.use"),
            () => {
                if (!value) return;
                use(value);
                close();
            },
            true
        ),
        copy,
        action(t("inline.again"), () => {
            value = generatePassword(options);
            copy.textContent = t("generator.copy");
            said.textContent = "";
            draw();
        })
    );
    panel.append(shown, row, said);
}

/**
 * Put a password on the clipboard from a press inside our panel.
 *
 * The clipboard API first; where the page's own policy refuses it, the older
 * copy command, from a box inside our closed shadow root - never one in the
 * page, where the page's scripts could read the password out of it.
 */
async function copyText(value: string, inside: HTMLElement): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(value);
        return true;
    } catch {
        const box = document.createElement("textarea");
        box.value = value;
        box.setAttribute("readonly", "");
        box.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
        inside.append(box);
        box.select();
        try {
            return document.execCommand("copy");
        } catch {
            return false;
        } finally {
            box.remove();
        }
    }
}

/** The timer emptying the clipboard on this page, if one is waiting. */
let clearing: number | null = null;

/**
 * Empty the clipboard a while after a password was copied to it, the way a
 * password manager does - and from the next page this runs on when this one is
 * gone first, which is the ordinary case after a sign-up.
 */
function clearClipboardLater(): void {
    const due = Date.now() + CLIPBOARD_CLEAR_MS;
    void storage.setItem(CLIPBOARD_CLEAR_KEY, due).catch(() => undefined);
    armClearing(due);
}

function armClearing(due: number): void {
    if (clearing !== null) window.clearTimeout(clearing);
    clearing = window.setTimeout(() => void emptyClipboard(due), Math.max(0, due - Date.now()));
}

/** Empty it now - or once this page has the focus, which writing to the
 *  clipboard needs - and forget the deadline it was for. */
async function emptyClipboard(due: number): Promise<void> {
    clearing = null;
    try {
        await navigator.clipboard.writeText("");
    } catch {
        if (Date.now() - due > CLIPBOARD_GIVE_UP_MS) await forgetClearing(due);
        else window.addEventListener("focus", () => void emptyClipboard(due), { once: true });
        return;
    }
    await forgetClearing(due);
}

async function forgetClearing(due: number): Promise<void> {
    try {
        if ((await storage.getItem<number>(CLIPBOARD_CLEAR_KEY)) === due)
            await storage.removeItem(CLIPBOARD_CLEAR_KEY);
    } catch {
        // A deadline left behind empties an already empty clipboard once more.
    }
}

/** A deadline a page before this one left unfinished. */
async function finishClearing(): Promise<void> {
    try {
        const due = await storage.getItem<number>(CLIPBOARD_CLEAR_KEY);
        if (typeof due !== "number") return;
        if (Date.now() - due > CLIPBOARD_GIVE_UP_MS) await forgetClearing(due);
        else armClearing(due);
    } catch {
        // Storage that will not answer has nothing to finish.
    }
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
    const shift = frameOffset(field);
    const host = ourHost();
    host.style.cssText = `
        position: fixed;
        z-index: 2147483645;
        top: ${shift.y + box.bottom + 4}px;
        left: ${shift.x + box.left}px;
        width: ${Math.max(240, Math.min(360, box.width))}px;
    `;
    const shadow = host.attachShadow({ mode: "closed" });
    const line = document.createElement("p");
    line.textContent =
        count === 1
            ? t("inline.breachOne")
            : t("inline.breachMany", { count: count.toLocaleString(t.locale) });
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
async function offerHeld(before?: () => Promise<void>): Promise<void> {
    const reply = await askBackground({ kind: "pendingCapture" });
    if (reply.ok && "offer" in reply) bar(reply.offer, before);
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
function bar(offer: OfferedCapture, before?: () => Promise<void>): void {
    if (offer.kind === "none") return;
    barHost?.remove();

    const host = ourHost();
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
    // i18n-ignore the product's name
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
            ? t("inline.updateSaved", { name: offer.name ?? t("inline.thisLogin") })
            : t("inline.saveThis");

    const who = document.createElement("p");
    who.style.cssText = "margin:0 0 10px;color:hsl(222 10% 66%);word-break:break-all;";
    who.textContent = [offer.username, offer.kind === "save" ? offer.name : null]
        .filter(Boolean)
        .join(" - ");

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
    row.append(
        action(
            offer.kind === "update" ? t("inline.update") : t("popup.save"),
            () => {
                // What the form says now goes in, not what it said when the bar
                // appeared: a username typed after a password was generated.
                void (before?.() ?? Promise.resolve())
                    .catch(() => undefined)
                    .then(() => askBackground({ kind: "saveCaptured" }))
                    .then((reply) => {
                        if (reply.ok) {
                            close();
                            return;
                        }
                        // The one place a refusal is worth showing: somebody pressed a
                        // button and nothing happened otherwise. It keeps a way out -
                        // a bar that says why it failed and cannot be closed is worse
                        // than the failure.
                        title.textContent = "error" in reply ? reply.error : t("errors.notSaved");
                        who.remove();
                        row.replaceChildren(action(t("generator.close"), close));
                    });
            },
            true
        ),
        action(t("inline.notNow"), () => {
            void askBackground({ kind: "dismissCapture", never: false });
            close();
        }),
        action(t("inline.neverHere"), () => {
            void askBackground({ kind: "dismissCapture", never: true });
            close();
        })
    );

    panel.append(title, who, row);
    shadow.append(panel);
    document.body.append(host);
}
