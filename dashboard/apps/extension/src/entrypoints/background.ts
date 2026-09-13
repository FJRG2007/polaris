import { storage } from "#imports";
import * as protocol from "@/lib/protocol";
import * as messages from "@/lib/messages";
import { decryptBytes } from "@polaris/vault-crypto";
import type { SymmetricKey } from "@polaris/vault-crypto";
import { readUriMatch, type UriMatch } from "@polaris/core";
import { displayHost, matchesPage, rankForPage } from "@/lib/matching";
import { deriveMasterKey, masterPasswordHash, stretchMasterKey } from "@polaris/vault-crypto";
import { decrypt, decryptRsa, fromBase64, symmetricKeyFromBytes } from "@polaris/vault-crypto";
import {
    currentOrigin,
    forgetOrigin,
    grantOrigin,
    holdsOrigin,
    readOrigin,
    rememberOrigin,
    vaultBase
} from "@/lib/server";

/**
 * Everything that touches a key, a token or the network.
 *
 * The split is the whole security design of this extension, so it is stated here
 * rather than left to be inferred: **the vault key never leaves this worker.**
 * The popup asks for a list and gets names and usernames; a page asks to be
 * filled and gets the two strings it was about to have typed into it, for the
 * item somebody chose, on the site that was already in front of them. Neither
 * ever holds the key, the token, or an item it did not ask for - because anything
 * running inside a page can be read by that page.
 *
 * Nothing is declared into pages at all. The function that types into a form is
 * injected on the tab in front of somebody at the moment they ask for it, so the
 * manifest asks for no access to any site - see `typeIntoPage`.
 *
 * What is kept where:
 *
 * - The **user key** and the private half of the pair: memory only, in this
 *   worker. Locking drops them; so does the worker being recycled, which under
 *   manifest v3 happens whenever the browser feels like it. That is a lock that
 *   happens on its own, and it is the correct behaviour rather than a bug to work
 *   around - the alternative is key material at rest.
 * - The **refresh token**: `storage.session`, which the browser clears when it
 *   closes. It is a credential, so it does not go to disk.
 * - The **ciphers**: `storage.session` as they arrived, still encrypted. They are
 *   unreadable without the key above, which is not stored anywhere, so a worker
 *   that comes back needs the master password again to read them - and until then
 *   it can still say how many there are and when they came down.
 * - The **server address and the email**: `storage.local`, because they are not
 *   secrets and asking for them on every browser start would be theatre.
 *
 * There is deliberately no "never lock" setting. It would mean keeping the key
 * where a restart cannot take it, which is the one thing this design is for.
 */

/** The account's own vault, held only while it is open. */
interface OpenVault {
    readonly key: SymmetricKey;
    /** Each other vault's key, by the id its items carry. */
    readonly organizations: ReadonlyMap<string, SymmetricKey>;
}

let open: OpenVault | null = null;

/** What came down last sync, still encrypted, so a recycled worker keeps it. */
const CIPHERS = storage.defineItem<protocol.SyncResponse | null>("session:vault.ciphers", {
    fallback: null
});
const SYNCED_AT = storage.defineItem<number | null>("session:vault.syncedAt", { fallback: null });
const REVISION = storage.defineItem<number | null>("session:vault.revision", { fallback: null });
const REFRESH = storage.defineItem<string | null>("session:vault.refresh", { fallback: null });
const ACCESS = storage.defineItem<{ token: string; expiresAt: number } | null>(
    "session:vault.access",
    { fallback: null }
);
const EMAIL = storage.defineItem<string | null>("local:vault.email", { fallback: null });
const DEVICE = storage.defineItem<string | null>("local:vault.device", { fallback: null });
/** The wrapped keys, kept so unlocking does not need the network. */
const WRAPPED = storage.defineItem<{ key: string; privateKey: string | null; kdf: unknown } | null>(
    "session:vault.wrapped",
    { fallback: null }
);

/** This browser, named so a session list is readable by the person who owns it. */
async function device(): Promise<{ identifier: string; name: string }> {
    let identifier = await DEVICE.getValue();
    if (!identifier) {
        identifier = crypto.randomUUID();
        await DEVICE.setValue(identifier);
    }
    const named: Record<string, string> = {
        firefox: "Firefox extension",
        edge: "Edge extension",
        opera: "Opera extension"
    };
    return { identifier, name: named[import.meta.env.BROWSER] ?? "Chrome extension" };
}

/** A live access token, refreshed when it is close to expiring. */
async function token(base: string): Promise<string | null> {
    const held = await ACCESS.getValue();
    if (held && held.expiresAt > Date.now()) return held.token;

    const refreshToken = await REFRESH.getValue();
    if (!refreshToken) return null;
    const fresh = await protocol.refresh(base, refreshToken);
    if (!fresh) {
        // The server rotates refresh tokens, so a refusal is the end of this
        // session rather than something to retry: whatever we hold is spent.
        await Promise.all([REFRESH.setValue(null), ACCESS.setValue(null)]);
        return null;
    }
    await remember(fresh);
    return fresh.accessToken;
}

async function remember(issued: protocol.VaultToken): Promise<void> {
    await Promise.all([
        REFRESH.setValue(issued.refreshToken),
        ACCESS.setValue({ token: issued.accessToken, expiresAt: issued.expiresAt }),
        WRAPPED.setValue({ key: issued.key, privateKey: issued.privateKey, kdf: issued.kdf })
    ]);
}

/**
 * Every other vault's key, unwrapped with this account's private half.
 *
 * Read from whatever the last sync left, and so worked out again whenever that
 * changes rather than once while unlocking. A vault opened before any sync has
 * landed - signing in against a server that was briefly unreachable, which
 * unlocks anyway because the password is in hand - has no profile to read, and
 * held once it would stay empty for the session: every shared item silently
 * undecryptable, with nothing on screen saying why.
 *
 * A vault whose key will not open is skipped rather than fatal: it means
 * somebody has not been let in yet.
 */
async function organizationKeys(key: SymmetricKey): Promise<Map<string, SymmetricKey>> {
    const organizations = new Map<string, SymmetricKey>();
    const [wrapped, held] = await Promise.all([WRAPPED.getValue(), CIPHERS.getValue()]);
    if (!wrapped?.privateKey || !held) return organizations;

    const pkcs8 = await decryptBytes(wrapped.privateKey, key);
    if (!pkcs8) return organizations;
    const profile = held.profile as { organizations?: { id?: unknown; key?: unknown }[] };
    for (const organization of profile.organizations ?? []) {
        if (typeof organization.id !== "string" || typeof organization.key !== "string") continue;
        const orgKey = await decryptRsa(organization.key, pkcs8);
        if (orgKey && orgKey.length === 64) {
            organizations.set(organization.id, symmetricKeyFromBytes(orgKey));
        }
    }
    return organizations;
}

/**
 * Open the vault with the master password.
 *
 * The password is turned into a key here and dropped; what is kept is what it
 * unwrapped. Nothing derived from it is written anywhere, which is why this has
 * to be asked again after the browser - or the worker - has been away.
 */
async function unlock(password: string): Promise<boolean> {
    const [email, wrapped] = await Promise.all([EMAIL.getValue(), WRAPPED.getValue()]);
    if (!email || !wrapped) return false;

    const settings = wrapped.kdf as Parameters<typeof deriveMasterKey>[2];
    const masterKey = await deriveMasterKey(password, email, settings);
    const stretched = await stretchMasterKey(masterKey);
    const raw = await decryptBytes(wrapped.key, stretched);
    if (raw === null || raw.length !== 64) return false;
    const key = symmetricKeyFromBytes(raw);

    open = { key, organizations: await organizationKeys(key) };
    return true;
}

/** Which key opens this item: its vault's, or the account's own. */
function keyFor(cipher: Record<string, unknown>): SymmetricKey | null {
    if (!open) return null;
    const organizationId = cipher["organizationId"];
    if (typeof organizationId === "string") return open.organizations.get(organizationId) ?? null;
    return open.key;
}

/** One login, decrypted only as far as a caller asked for. */
interface Login {
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
    readonly password: string | null;
    readonly totp: string | null;
    readonly uris: readonly { uri: string; match: UriMatch | null }[];
}

/** The login type, as the wire numbers it. */
const CIPHER_LOGIN = 1;

async function readLogin(cipher: Record<string, unknown>): Promise<Login | null> {
    if (Number(cipher["type"]) !== CIPHER_LOGIN) return null;
    const key = keyFor(cipher);
    if (!key) return null;
    const id = cipher["id"];
    if (typeof id !== "string") return null;

    const login = (cipher["login"] ?? {}) as Record<string, unknown>;
    const say = async (value: unknown): Promise<string | null> =>
        typeof value === "string" && value !== "" ? await decrypt(value, key) : null;

    const uris: { uri: string; match: UriMatch | null }[] = [];
    for (const entry of (login["uris"] as Record<string, unknown>[] | undefined) ?? []) {
        const uri = await say(entry["uri"]);
        if (uri) uris.push({ uri, match: readUriMatch(entry["match"]) });
    }

    return {
        id,
        name: (await say(cipher["name"])) ?? "Untitled",
        username: await say(login["username"]),
        password: await say(login["password"]),
        totp: await say(login["totp"]),
        uris
    };
}

/** Every login this account can open, decrypted. */
async function logins(): Promise<Login[]> {
    const held = await CIPHERS.getValue();
    if (!held || !open) return [];
    const found: Login[] = [];
    for (const cipher of held.ciphers) {
        if (cipher["deletedDate"]) continue;
        const login = await readLogin(cipher);
        if (login) found.push(login);
    }
    return found;
}

/**
 * The logins saved for a page, best first.
 *
 * Matching is `@polaris/core`'s, the same function the Polaris screens use, so a
 * URI that matches in the dashboard matches here. `never` is honoured and the two
 * dangerous strategies are not offered by this client at all - a stored regular
 * expression that matches more than its author expected hands a password to a
 * site that only had to put the right word in its query string.
 */
async function forUrl(url: string): Promise<Login[]> {
    return rankForPage(await logins(), url);
}

function summarize(login: Login): messages.ItemSummary {
    return {
        id: login.id,
        name: login.name,
        username: login.username,
        host: displayHost(login.uris),
        totp: login.totp !== null
    };
}

async function status(): Promise<messages.VaultStatus> {
    const [server, email, refreshToken, syncedAt] = await Promise.all([
        currentOrigin(),
        EMAIL.getValue(),
        REFRESH.getValue(),
        SYNCED_AT.getValue()
    ]);
    return {
        server,
        email,
        connected: refreshToken !== null,
        unlocked: open !== null,
        syncedAt
    };
}

/**
 * Bring the vault down, if there is anything new.
 *
 * The revision date is one row rather than every item, so it is what a poll asks
 * and a full sync happens only when the answer moved. Polaris serves no push, by
 * design, so this is the only way a second browser's change arrives.
 */
async function sync(force: boolean): Promise<boolean> {
    const origin = await currentOrigin();
    if (!origin) return false;
    const base = vaultBase(origin);
    const access = await token(base);
    if (!access) return false;

    const moved = await protocol.revisionDate(base, access);
    if (!force) {
        const seen = await REVISION.getValue();
        if (moved !== null && seen !== null && moved <= seen) return true;
    }

    const fresh = await protocol.sync(base, access);
    if (!fresh) return false;
    await Promise.all([
        CIPHERS.setValue(fresh),
        SYNCED_AT.setValue(Date.now()),
        // The server's revision, never this browser's clock, because that is what
        // the poll above compares it against. Stored as `Date.now()` the two were
        // different clocks: a machine running even slightly ahead of the server
        // held a number no revision it reported could exceed, so every later poll
        // decided there was nothing new and a password changed on another device
        // never arrived. Left alone when the server did not say, so the next poll
        // asks again rather than trusting a gap.
        ...(moved !== null ? [REVISION.setValue(moved)] : [])
    ]);
    // The profile arrived with it, and it is what the other vaults' keys are read
    // from - so an open vault that started without them has them now.
    if (open) open = { key: open.key, organizations: await organizationKeys(open.key) };
    await badge();
    return true;
}

/**
 * How many logins are saved for the tab in front of somebody.
 *
 * The only thing this extension says without being asked, and it is the signal
 * that it is working at all. Blank while locked rather than zero: none saved and
 * cannot tell are different answers.
 */
async function badge(): Promise<void> {
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        const url = tab?.url ?? "";
        const text = open && /^https?:/i.test(url) ? String((await forUrl(url)).length || "") : "";
        await browser.action.setBadgeText({ text });
        await browser.action.setBadgeBackgroundColor({ color: "#2f6feb" });
    } catch {
        // A badge is not worth an error path: a tab that went away between the
        // query and the write is the normal case, not a fault.
    }
}

/**
 * The one thing this extension puts inside a page, and only when asked.
 *
 * Injected at the moment of a fill rather than declared in the manifest, because
 * a declared content script IS a host permission: `matches: ["<all_urls>"]` is
 * the browser telling somebody, at install time, that this extension may read
 * every page they open - which is the access the manifest deliberately does not
 * ask for. Injected onto the tab in front of them instead, the same work happens
 * with no standing reach into anything.
 *
 * Self-contained by necessity: the browser serializes this function and runs it
 * in the page, so it cannot see one thing outside its own body - not an import,
 * not a constant, not another function in this file. That is also why the two
 * strings arrive as arguments. By the time it runs, which item to use has already
 * been decided, and the page is handed nothing it was not about to be typed.
 *
 * It does not submit the form. Filling is the help somebody asked for; pressing
 * the button for them is a decision nobody made.
 */
function typeIntoPage(
    username: string | null,
    password: string | null
): { user: boolean; pass: boolean } {
    const never = new Set([
        "hidden",
        "file",
        "button",
        "image",
        "reset",
        "submit",
        "checkbox",
        "radio",
        "range",
        "color"
    ]);
    const notALogin = /search|captcha|find|query|coupon|voucher|discount|promo/i;
    const identifier =
        /user|login|email|correo|usuario|e-?mail|account|cuenta|identifiant|benutzer|nome|phone|telefono|mobile/i;

    const describe = (field: HTMLInputElement): string =>
        [
            field.name,
            field.id,
            field.placeholder,
            field.title,
            field.getAttribute("aria-label") ?? "",
            field.labels?.[0]?.textContent ?? ""
        ]
            .join(" ")
            .toLowerCase();

    const usable = (field: HTMLInputElement): boolean => {
        if (never.has(field.type) || field.disabled || field.readOnly) return false;
        const box = field.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) return false;
        return getComputedStyle(field).visibility !== "hidden";
    };

    const inputs = [...document.querySelectorAll("input")].filter(usable);
    // The password first, because `type="password"` is not a guess. The name that
    // goes with it is then looked for in the same form, or among the fields
    // BEFORE it when there is no form - which is the order a login form is
    // written in, and why the search box at the top of the page is not mistaken
    // for the username.
    const pass = inputs.find((field) => field.type === "password" && field.autocomplete !== "new-password") ?? null;
    const candidates = pass
        ? inputs.filter((field) =>
              pass.form ? field.form === pass.form : inputs.indexOf(field) < inputs.indexOf(pass)
          )
        : inputs;

    const named = (field: HTMLInputElement): boolean => {
        const token = field.autocomplete?.toLowerCase() ?? "";
        if (token === "username" || token === "email") return true;
        if (token !== "off" && token !== "") return false;
        if (!["text", "email", "tel", "number"].includes(field.type)) return false;
        const words = describe(field);
        if (notALogin.test(words)) return false;
        return identifier.test(words) || field.type === "email";
    };
    const user = candidates.find(named) ?? null;

    // Written through the property descriptor and then announced: a form built
    // with a framework holds its own copy of what it believes the field says, so
    // a value assigned straight to `value` is one the page never learns about and
    // discards on submit.
    const put = (field: HTMLInputElement, value: string): void => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        field.focus();
        descriptor?.set?.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.blur();
    };

    if (username && user) put(user, username);
    if (password && pass) put(pass, password);
    return { user: Boolean(user), pass: Boolean(pass) };
}

/** Type the two strings into the page in front of somebody. */
async function fill(id: string): Promise<messages.Reply> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return { ok: false, error: "There is no page to fill." };
    const login = (await logins()).find((one) => one.id === id);
    if (!login) return { ok: false, error: "That item is not open." };

    // Re-checked here, against the tab as it is now: between the popup drawing a
    // list and somebody pressing it, a page can navigate, and a fill must never
    // land on a site the item was not saved for. Through the same function the
    // list was built from, so the two cannot disagree about what belongs where -
    // and it is the one the tests cover.
    if (!matchesPage(login.uris, tab.url)) {
        return { ok: false, error: "That item is not saved for this site." };
    }

    try {
        // What the page actually found, rather than that the message was
        // delivered. The popup closes itself on success, so a page with no login
        // form on it used to have the popup vanish as though the two strings had
        // been typed into it - and somebody then submits an empty form, or
        // pastes a password into whatever is focused, looking for the one they
        // were told had already been filled in.
        const [outcome] = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: typeIntoPage,
            args: [login.username, login.password]
        });
        const filled = outcome?.result as { user?: boolean; pass?: boolean } | undefined;
        if (!filled?.user && !filled?.pass) {
            return { ok: false, error: "No login form was found on this page." };
        }
        return { ok: true };
    } catch {
        return { ok: false, error: "This page cannot be filled." };
    }
}

browser.runtime.onMessage.addListener((raw, sender, sendResponse): boolean => {
    // Only the extension's own pages may ask for any of this. A page that
    // guessed the extension id gets nothing: anything that is not one of ours is
    // refused before it is parsed.
    if (sender.id !== browser.runtime.id) return false;
    // And the id alone is not that boundary, because anything injected into a
    // page carries it too - so this surface, which hands back decrypted items,
    // would be open to script running inside whatever page somebody is on. Ours
    // speak from no tab; anything sent from inside a page has one.
    if (sender.tab) return false;
    const request = raw as messages.Request;

    const answer = async (): Promise<messages.Reply> => {
        switch (request.kind) {
            case "status":
                return { ok: true, status: await status() };

            case "connect": {
                const origin = readOrigin(request.typed);
                if (!origin) return { ok: false, error: "That does not look like an address." };
                const granted = (await holdsOrigin(origin)) || (await grantOrigin(origin));
                if (!granted) {
                    return { ok: false, error: "Without permission for that address, nothing can be read from it." };
                }
                await rememberOrigin(origin);
                return { ok: true, status: await status() };
            }

            case "signIn": {
                const origin = await currentOrigin();
                if (!origin) return { ok: false, error: "Say which Polaris this is first." };
                const base = vaultBase(origin);
                const email = request.email.trim().toLowerCase();
                const settings = await protocol.prelogin(base, email);
                if (!settings) return { ok: false, error: "That server did not answer." };

                const masterKey = await deriveMasterKey(request.password, email, settings);
                const hash = await masterPasswordHash(masterKey, request.password);
                const result = await protocol.signIn(base, {
                    email,
                    masterPasswordHash: hash,
                    device: await device(),
                    twoFactorToken: request.code
                });
                if (!result.ok) {
                    if (result.kind === "two_factor") {
                        return { ok: false, error: "Enter the code from your authenticator.", needsCode: true };
                    }
                    if (result.kind === "rate_limited") {
                        const minutes = Math.ceil(result.retryAfterMs / 60_000);
                        return { ok: false, error: `Too many attempts. Try again in ${minutes} minutes.` };
                    }
                    if (result.kind === "unreachable") {
                        return { ok: false, error: "That server could not be reached." };
                    }
                    return { ok: false, error: "That address and password did not open the vault." };
                }

                await EMAIL.setValue(email);
                await remember(result.token);
                // Signed in and open in one step: the password is in hand, and
                // asking for it again immediately would be theatre.
                await sync(true);
                await unlock(request.password);
                await badge();
                return { ok: true, status: await status() };
            }

            case "unlock": {
                const opened = await unlock(request.password);
                if (!opened) return { ok: false, error: "That password did not open the vault." };
                void sync(false);
                await badge();
                return { ok: true, status: await status() };
            }

            case "lock":
                open = null;
                await badge();
                return { ok: true, status: await status() };

            case "signOut":
                open = null;
                await Promise.all([
                    REFRESH.setValue(null),
                    ACCESS.setValue(null),
                    WRAPPED.setValue(null),
                    CIPHERS.setValue(null),
                    SYNCED_AT.setValue(null),
                    REVISION.setValue(null),
                    EMAIL.setValue(null),
                    forgetOrigin()
                ]);
                await badge();
                return { ok: true, status: await status() };

            case "sync":
                return (await sync(true))
                    ? { ok: true, status: await status() }
                    : { ok: false, error: "Nothing came back from that server." };

            case "itemsFor":
                return { ok: true, items: (await forUrl(request.url)).map(summarize) };

            case "items": {
                const query = request.query.trim().toLowerCase();
                const all = await logins();
                const found = query
                    ? all.filter(
                          (login) =>
                              login.name.toLowerCase().includes(query) ||
                              (login.username ?? "").toLowerCase().includes(query)
                      )
                    : all;
                return { ok: true, items: found.slice(0, 100).map(summarize) };
            }

            case "fill":
                return fill(request.id);

            case "copy": {
                const login = (await logins()).find((one) => one.id === request.id);
                if (!login) return { ok: false, error: "That item is not open." };
                // The popup writes to the clipboard itself, from the gesture that
                // asked for it: a worker has no document to copy from, and the
                // value crosses to a page of ours rather than to a web page.
                const value =
                    request.field === "username"
                        ? login.username
                        : request.field === "password"
                          ? login.password
                          : login.totp;
                return value ? { ok: true, value } : { ok: false, error: "There is nothing to copy." };
            }
        }
    };

    // Answered through the callback, with `return true` to hold the channel open -
    // never by returning the promise. Firefox accepts a returned promise here;
    // Chrome ignores it and closes the channel immediately, so every request the
    // popup ever made would resolve to `undefined` and the extension would look
    // like it does nothing at all. WXT ships no polyfill over that difference:
    // `browser` is the native object.
    void answer()
        .catch((error: unknown): messages.Reply => {
            console.error("polaris: the vault worker could not answer:", error);
            return { ok: false, error: "Something went wrong." };
        })
        .then(sendResponse);
    return true;
});

/**
 * Fill from the keyboard, on the page in front of somebody.
 *
 * The best match for the tab, which is the same order the popup shows, so the
 * shortcut and the list agree about what "the login for this page" means.
 *
 * Silent when the vault is locked or nothing matches: a shortcut that answered by
 * demanding a master password would be a keystroke that opens a password prompt
 * somebody did not ask for, and one that filled the only item it could find on a
 * page it was not saved for would be worse.
 */
async function fillFromKeyboard(command: string): Promise<void> {
    if (command !== "fill-login" || !open) return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/i.test(tab.url)) return;
    const best = (await forUrl(tab.url))[0];
    if (best) await fill(best.id);
}

/** Keep the badge honest as somebody moves around. */
browser.tabs.onActivated.addListener(() => void badge());
browser.tabs.onUpdated.addListener((_id, change) => {
    if (change.url || change.status === "complete") void badge();
});

export default defineBackground(() => {
    // Registered here rather than beside the others above, and not by preference:
    // WXT evaluates this module during the build against a stand-in browser that
    // implements no `commands`, so a top-level registration throws there and takes
    // the build with it. Inside this function it runs when the worker starts,
    // which is still synchronous registration - what manifest v3 requires of a
    // listener that has to survive the worker being recycled.
    browser.commands.onCommand.addListener((command) => void fillFromKeyboard(command));

    // Nothing else to do on install. The keys are not here yet and asking for them
    // before somebody opens the popup would be asking the browser to hold a
    // master password, which is the one thing this design refuses.
    void badge();
});
