import { storage } from "#imports";
import * as protocol from "@/lib/protocol";
import * as messages from "@/lib/messages";
import * as accounts from "@/lib/accounts";
import { withNewPassword } from "@/lib/item";
import { readIntendedLogin } from "@/lib/save";
import { injectableOrigins } from "@/lib/injection";
import { decryptBytes } from "@polaris/vault-crypto";
import type { SymmetricKey } from "@polaris/vault-crypto";
import { noticeFor, type UpdateNotice } from "@/lib/update";
import { hostOf, readUriMatch, type UriMatch } from "@polaris/core";
import { totpCode, totpRemaining } from "@polaris/vault-crypto/totp";
import { displayHost, isBlockedHost, matchesPage, rankForPage } from "@/lib/matching";
import { DEFAULT_TIMEOUT_MS, deadlineFrom, hasExpired, readTimeout } from "@/lib/lock";
import { deriveMasterKey, masterPasswordHash, stretchMasterKey } from "@polaris/vault-crypto";
import {
    decrypt,
    decryptRsa,
    encrypt,
    fromBase64,
    generateRsaKeyPair,
    symmetricKeyFromBytes
} from "@polaris/vault-crypto";
import {
    currentOrigin,
    forgetOrigin,
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
 * Nothing is declared into pages by the manifest, which still asks for access to
 * no site at all. Two things nevertheless end up running inside one, and they are
 * different in a way worth keeping straight:
 *
 * - The function that types into a form is injected on the tab in front of
 *   somebody at the moment they ask for it, and only then - see `typeIntoPage`.
 * - The inline login mark is a file with no manifest entry, registered at runtime
 *   for the origins somebody has granted by hand and no others - see
 *   `syncAutofill`, and `lib/injection` for the rule that a broad grant is never
 *   registered on.
 *
 * Neither is a standing reach over every page: the first outlives one call, the
 * second outlives only the grant it was made for.
 *
 * What is kept where:
 *
 * - The **user key** and the private half of the pair: memory only, in this
 *   worker. Locking drops them; so does the worker being recycled, which under
 *   manifest v3 happens whenever the browser feels like it. That is a lock that
 *   happens on its own, and it is the correct behaviour rather than a bug to work
 *   around - the alternative is key material at rest. It is not something to
 *   RELY on, though, and this comment used to imply it was: a manifest v2
 *   background page is persistent, so on Firefox nothing recycles this and an
 *   unlocked vault stayed unlocked until the browser closed. The deadline in
 *   `lib/lock.ts` is what makes the two behave alike, and an alarm enforces it
 *   whether or not anybody opens the popup.
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
 * where a restart cannot take it, which is the one thing this design is for - so
 * the longest the setting offers is the browser session.
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
/**
 * The credential for the account, as opposed to for the vault.
 *
 * Session storage, beside the refresh token and for the same reason: it is a
 * credential, so it does not go to disk and the browser closing takes it. What
 * it buys is the extension being able to say whose account this is without
 * asking anybody to sign in a second time - it reaches no further than the
 * vault permission it was minted with.
 */
const ACCOUNT_KEY = storage.defineItem<string | null>("session:vault.accountKey", {
    fallback: null
});
/**
 * Who the credential above says this is, once it has been asked.
 *
 * Cached because the popup reads the status on every open and after every
 * action, and the answer changes when somebody signs out rather than minute to
 * minute - asking the server each time would be a request per keystroke in the
 * search box. Session storage, next to the credential it came from: it is not a
 * secret, but it is meaningless without one, and keeping them together means
 * one thing to clear rather than two to remember.
 */
const ACCOUNT = storage.defineItem<messages.ExtensionAccount | null>("session:vault.account", {
    fallback: null
});
/**
 * The other accounts this browser is signed in to, waiting to be switched back to.
 *
 * Session storage, because each one carries a refresh token and that is the rule
 * every credential here follows: the browser closing takes them, exactly as it
 * takes the active account's own. So a restart signs out of all of them rather
 * than of one, which is the same promise made the same number of times.
 *
 * What is NOT in here is any vault key. Those stay in memory, in `parkedVaults`
 * below, for the same reason the active one does.
 */
const PARKED = storage.defineItem<accounts.ParkedAccount[]>("session:vault.parked", {
    fallback: []
});

/**
 * Each parked account's open vault, and the deadline it was parked with.
 *
 * Memory only, beside `open`, and holding several is the same posture as holding
 * one: nothing is at rest, and a recycled worker drops all of them together. The
 * deadline travels with the key so that being set aside does not exempt a vault
 * from its own timeout - sitting in this map is the purest disuse there is, and a
 * vault that aged out while parked comes back locked rather than open.
 */
const parkedVaults = new Map<string, { vault: OpenVault; lockAt: number | null }>();
/**
 * Sites this extension is to keep out of.
 *
 * Local rather than session, because it is an instruction rather than a
 * credential and somebody who said "never here" means it after a restart too.
 */
const BLOCKED = storage.defineItem<string[]>("local:blocked.hosts", { fallback: [] });
const DEVICE = storage.defineItem<string | null>("local:vault.device", { fallback: null });
/**
 * A published build newer than this one, once a check has found it.
 *
 * Local rather than session, and deliberately: it is a fact about what has been
 * released rather than a credential, and somebody who has not got round to
 * reloading the extension should still be told tomorrow.
 */
const UPDATE = storage.defineItem<UpdateNotice | null>("local:update.notice", { fallback: null });
/** The wrapped keys, kept so unlocking does not need the network. */
const WRAPPED = storage.defineItem<{ key: string; privateKey: string | null; kdf: unknown } | null>(
    "session:vault.wrapped",
    { fallback: null }
);
/**
 * A request waiting for somebody to approve it in the dashboard.
 *
 * Session storage, because it is a credential: whoever holds the code can collect
 * the approval. It lives there rather than in memory because a manifest v3 worker
 * is recycled whenever the browser feels like it, and a request that somebody has
 * gone to approve must survive that - otherwise the approval lands on a code
 * nothing is waiting on any more.
 *
 * The private half of the pair is the opposite: memory only, and losing it to a
 * recycle means the request simply cannot be collected. That is the correct
 * direction to fail in - key material at rest is the one thing this design will not
 * have - and the popup says so rather than leaving somebody waiting on a code that
 * can no longer be used.
 *
 * What became of it is kept here too, because the popup is not around to be told.
 * Opening the tab that approves a request is what closes the popup, so the answer
 * has to be waiting for whoever opens it next rather than delivered to whoever
 * asked.
 */
const WAITING = storage.defineItem<WaitingRequest | null>("session:vault.waiting", {
    fallback: null
});

/** Where the collection of an approval stands, as the worker's own loop left it. */
type AuthorizationState = "pending" | "approved" | "denied" | "expired" | "lost" | "unreadable";

/** A request in flight, and what has become of it. */
interface WaitingRequest {
    readonly deviceCode: string;
    readonly userCode: string;
    /** How often to ask, as the server asked and `protocol` held it to a period
     *  this client will actually wait. */
    readonly pollMs: number;
    /** When the server stops answering for this code, as a moment. */
    readonly until: number;
    readonly state: AuthorizationState;
}

/** The pair this extension generated for a request in flight. Memory only. */
let asking: { publicKey: string; privateKey: Uint8Array } | null = null;

/**
 * When the open vault locks itself, and how long it is given.
 *
 * The deadline is session storage beside the keys it guards, because it means
 * nothing once there is no open vault. The length is local: it is a preference
 * rather than a credential, and somebody who chose one minute still means it
 * tomorrow.
 */
const LOCK_AT = storage.defineItem<number | null>("session:vault.lockAt", { fallback: null });
const TIMEOUT = storage.defineItem<number>("local:vault.timeoutMs", {
    fallback: DEFAULT_TIMEOUT_MS
});

/**
 * The open vault, or null - locking it here when its deadline has passed.
 *
 * Every path that reads a key goes through this rather than through the variable,
 * so there is one place that answers "is it open" and no route can forget to ask.
 * Checked here as well as on the alarm because the alarm is a period: between two
 * ticks the deadline can pass, and the answer to a request has to be the current
 * one rather than the one the last tick left behind.
 */
async function vault(): Promise<OpenVault | null> {
    if (!open) return null;
    if (hasExpired(Date.now(), await LOCK_AT.getValue())) {
        open = null;
        return null;
    }
    return open;
}

/**
 * Push the deadline forward, because the vault has just been used.
 *
 * This is what makes it a timeout of disuse: somebody working through a list of
 * logins keeps moving it and is never interrupted, and a browser left alone on a
 * page stops moving it.
 */
async function touch(): Promise<void> {
    if (!open) return;
    await LOCK_AT.setValue(deadlineFrom(Date.now(), await TIMEOUT.getValue()));
}

/**
 * Drop the parked keys whose deadline has passed.
 *
 * `vault()` above does this for the account in front, on every use. A parked one
 * is used by nothing, so without a sweep its key sits in memory until somebody
 * happens to switch back to it. The switch already refuses a vault that aged out,
 * which makes this about retention rather than access - and retention is the half
 * that matters for a key nobody is going to be handed anyway.
 */
function sweepParkedVaults(now: number): void {
    for (const [id, held] of parkedVaults) {
        if (hasExpired(now, held.lockAt)) parkedVaults.delete(id);
    }
}

/**
 * The two runtime hints below, neither of which the standard types know about.
 *
 * `brave` is Brave's own way of being asked, and it is the only way: Brave
 * deliberately reports itself as Chrome everywhere else, so a session list built
 * from the user agent cannot tell the two apart and is not supposed to be able to.
 */
interface BrowserHints {
    readonly brave?: { readonly isBrave?: () => Promise<boolean> };
    readonly userAgentData?: {
        readonly brands?: readonly { readonly brand: string }[];
        readonly platform?: string;
    };
}

/**
 * Which browser this actually is, spelled the way the dashboard spells it.
 *
 * The build target answers for three of them, because a Firefox build only ever
 * runs in Firefox. It does NOT answer for the rest: one chrome-target build runs
 * in Chrome, Brave, Vivaldi, Edge and Opera alike, which is why somebody running
 * Brave was shown "Chrome extension" in their own session list - the name was the
 * build, not the browser.
 *
 * Every check degrades to Chrome rather than failing. A browser that will not say
 * what it is still has a vault to sign in to, and the name is a label on a row.
 */
async function browserName(): Promise<string> {
    const target = import.meta.env.BROWSER;
    if (target === "firefox") return "Firefox";
    if (target === "safari") return "Safari";
    if (target === "opera") return "Opera";
    if (target === "edge") return "Edge";

    const hints = navigator as unknown as BrowserHints;
    try {
        if (await hints.brave?.isBrave?.()) return "Brave";
    } catch {
        // Brave's own check refusing to answer is not worth failing a sign-in for.
    }

    const brands = hints.userAgentData?.brands ?? [];
    const claims = (word: string): boolean =>
        brands.some((entry) => entry.brand.toLowerCase().includes(word)) ||
        navigator.userAgent.toLowerCase().includes(word);
    // Order matters only in that Chrome is last: every one of these reports a
    // Chrome-shaped user agent as well as its own name.
    if (claims("edg")) return "Edge";
    if (claims("opr") || claims("opera")) return "Opera";
    if (claims("vivaldi")) return "Vivaldi";
    return "Chrome";
}

/** Which system this is on, in the spelling the dashboard's marks match. */
function systemName(): string | null {
    const hints = navigator as unknown as BrowserHints;
    const stated: Record<string, string> = {
        windows: "Windows",
        macos: "macOS",
        linux: "Linux",
        android: "Android",
        ios: "iOS"
    };
    const platform = hints.userAgentData?.platform?.trim().toLowerCase();
    if (platform && stated[platform]) return stated[platform];

    // Android before Linux and the phones before macOS: each of those user agents
    // contains the other's word, so the looser test has to come second.
    const agent = navigator.userAgent;
    if (/windows/i.test(agent)) return "Windows";
    if (/iphone|ipad|ipod/i.test(agent)) return "iOS";
    if (/android/i.test(agent)) return "Android";
    if (/mac os x|macintosh/i.test(agent)) return "macOS";
    if (/linux|x11/i.test(agent)) return "Linux";
    return null;
}

/**
 * This browser, named so a session list is readable by the person who owns it.
 *
 * "Brave on Windows" rather than "Chrome extension". The word "extension" is
 * gone from the name on purpose: the dashboard already has a column saying what
 * kind of client a row is, and repeating it here left no room for the one thing
 * the name could say that nothing else knew - which browser it is.
 */
async function device(): Promise<{ identifier: string; name: string }> {
    let identifier = await DEVICE.getValue();
    if (!identifier) {
        identifier = crypto.randomUUID();
        await DEVICE.setValue(identifier);
    }
    const browser = await browserName();
    const system = systemName();
    return { identifier, name: system === null ? browser : `${browser} on ${system}` };
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
    const [held, wrapped] = await Promise.all([EMAIL.getValue(), WRAPPED.getValue()]);
    if (!wrapped) return false;
    // A vault this browser was let into by approval typed no address, and the master
    // password cannot be stretched without one - it is the salt. Fetched from the
    // profile rather than refused, because what a refusal looks like on screen is a
    // locked vault telling somebody their correct password is wrong, with no way
    // back but signing out.
    let email = held;
    if (!email) {
        await sync(true);
        email = await EMAIL.getValue();
    }
    if (!email) return false;

    const settings = wrapped.kdf as Parameters<typeof deriveMasterKey>[2];
    const masterKey = await deriveMasterKey(password, email, settings);
    const stretched = await stretchMasterKey(masterKey);
    const raw = await decryptBytes(wrapped.key, stretched);
    if (raw === null || raw.length !== 64) return false;
    const key = symmetricKeyFromBytes(raw);

    open = { key, organizations: await organizationKeys(key) };
    return true;
}

/**
 * Open the vault with the key itself, rather than with a password.
 *
 * For the approval flow: a browser that is already inside the vault sealed the key
 * to this extension's public half, so what arrives here is the 64 bytes rather than
 * something to derive them from. Nothing else differs - the same key, the same
 * other-vault keys read off the same sync - which is why this is the same three
 * lines `unlock` ends with rather than a second way of being open.
 */
async function openWithKey(raw: Uint8Array): Promise<boolean> {
    if (raw.length !== 64) return false;
    const key = symmetricKeyFromBytes(raw);
    open = { key, organizations: await organizationKeys(key) };
    await LOCK_AT.setValue(deadlineFrom(Date.now(), await TIMEOUT.getValue()));
    return true;
}

/**
 * How long a request is given when the server did not say when it runs out.
 *
 * A bound rather than a copy of the server's own limit: what this is for is making
 * sure a loop polling an address that has stopped answering ends by itself.
 */
const AUTHORIZATION_FALLBACK_MS = 5 * 60 * 1000;

/** When a request stops being answerable, from what the server said about it. */
function readExpiry(expiresAt: string): number {
    const moment = Date.parse(expiresAt);
    return Number.isFinite(moment) ? moment : Date.now() + AUTHORIZATION_FALLBACK_MS;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The collection running right now, so one request is never polled twice over. */
let collecting: Promise<void> | null = null;

/**
 * Start collecting the approval, if nothing is collecting it already.
 *
 * Started from the request that opens one, and again from the alarm, which is what
 * makes a worker that came back mid-wait finish the request instead of leaving a
 * code somebody is approving with nothing on this side listening for it.
 */
function startCollecting(): void {
    if (collecting) return;
    collecting = collect().finally(() => {
        collecting = null;
    });
}

/** Leave the request where the popup will find out what happened to it. */
async function settle(waiting: WaitingRequest, state: AuthorizationState): Promise<void> {
    await WAITING.setValue({ ...waiting, state });
}

/**
 * Give up on the request in flight, key material included.
 *
 * Every way of walking away from an approval ends here, because the two halves of
 * abandoning one are easy to do singly and wrong apart. Forgetting the request
 * without zeroing the private half leaves live key bytes with nothing referring to
 * them; zeroing without forgetting leaves the loop polling a code it could no
 * longer open the answer to.
 *
 * What makes this more than tidiness is that the request is tied to whichever
 * account was in front when it was opened, and nothing in the answer says so. An
 * approval collected after the account changed is spent on the wrong one: the token
 * that comes back is written over the incoming account's, and the key that comes
 * back is opened as though it were theirs. So leaving an account is abandoning its
 * pending request, in the same breath, every time.
 */
async function abandonRequest(): Promise<void> {
    asking?.privateKey.fill(0);
    asking = null;
    await WAITING.setValue(null);
}

/**
 * Wait for somebody to approve the request, here in the worker.
 *
 * Here rather than in the popup, and that is the whole point of this function: the
 * request is opened by pressing a button in the popup, and the last thing that
 * handler does is open a tab on the dashboard - which moves the focus, which tears
 * the popup down, along with any timer it was holding. A poll that lived there
 * stopped at the exact moment somebody went off to say yes, so the approval was
 * never collected and pressing the button again only orphaned the first request.
 *
 * It ends in every direction. Approved opens the vault; denied and expired are the
 * server's own answers; a recycled worker has no private half left and so reports
 * the request lost; and an address that has stopped answering runs out with the
 * request rather than polling forever.
 */
async function collect(): Promise<void> {
    for (;;) {
        const waiting = await WAITING.getValue();
        if (!waiting || waiting.state !== "pending") return;
        // The private half is memory only, so a worker that was recycled cannot
        // open what an approval would carry. Said plainly rather than waited on.
        if (!asking) return settle(waiting, "lost");
        if (Date.now() >= waiting.until) return settle(waiting, "expired");

        await sleep(waiting.pollMs);

        // Read again after the wait: the popup may have cancelled it, or asked for
        // another, and this must not answer for a code nothing is waiting on.
        const still = await WAITING.getValue();
        if (!still || still.state !== "pending" || still.deviceCode !== waiting.deviceCode) return;

        const origin = await currentOrigin();
        if (!origin) return settle(still, "expired");
        const claim = await protocol.claimAuthorization(vaultBase(origin), still.deviceCode);
        // Nothing at all is a server that could not be reached, or would not answer
        // this poll: the request is still alive server-side, so this keeps waiting.
        if (!claim || claim.status === "pending") continue;
        if (claim.status !== "approved") return settle(still, claim.status);

        if (!asking) return settle(still, "lost");
        const privateKey = asking.privateKey;
        asking = null;
        const raw = await decryptRsa(claim.wrappedKey, privateKey);
        privateKey.fill(0);

        /*
         * Still wanted? Asked here, after the decrypt and before anything at all
         * is written.
         *
         * `asking` was nulled three lines up, which is what abandoning a request
         * looks for - so an account switch landing anywhere in that decrypt finds
         * nothing to abandon and this loop would carry on regardless. What it
         * would then do is the damage: `openWithKey` puts the approving account's
         * vault key in front of whoever is there now, and `remember` writes that
         * account's token over theirs. The same gap let `settle` below resurrect
         * a request record that had already been cleared, so the account somebody
         * switched INTO reported losing a request it never made.
         *
         * The record is the thing that says whether this is still wanted, so it
         * is what decides. Nothing is settled on the way out: writing a state
         * here is what put the record back.
         */
        const wanted = await WAITING.getValue();
        if (!wanted || wanted.deviceCode !== still.deviceCode) return;

        if (!raw || !(await openWithKey(raw))) {
            // Approved, and unreadable. Nothing is kept: a session that cannot
            // decrypt anything is worse than none, because it looks signed in.
            return settle(still, "unreadable");
        }

        await remember(claim.token);
        // Kept only when the server sent one. An older Polaris does not, and an
        // absent credential has to read as "this server does not do that" rather
        // than as an error on a sign-in that otherwise worked perfectly.
        if (claim.accountKey) await ACCOUNT_KEY.setValue(claim.accountKey);
        // The address this vault belongs to arrives with the profile, and the sync
        // below is what records it. Nothing was typed on this way in, and `unlock`
        // cannot stretch a master password without it.
        await sync(true);
        // The sync is what names this account, so only now can it be told from the
        // rows in the list - one of which may be this same account, parked before
        // the approval and holding a token this one has just replaced.
        await dropParked(accounts.accountId(origin, await EMAIL.getValue()));
        await badge();
        return settle(still, "approved");
    }
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
    /** Which vault it belongs to, or null for this account's own. Carried so the
     *  list can say which of two identical logins is which - see `vaultNames`. */
    readonly organizationId: string | null;
}

/**
 * What each vault is called, by the id its items carry.
 *
 * Read straight off the last sync's profile and never decrypted, because a
 * vault's name is not a secret and does not arrive as one: the server sends it
 * in plain text so a client can name a vault before it can open it.
 *
 * Separate from `organizationKeys` on purpose. That one needs the account's
 * private key and runs on unlock; this needs nothing and is wanted on every
 * listing, including for a vault whose key would not unwrap - which is somebody
 * who has been invited and not yet let in, and whose rows should still say where
 * they came from.
 */
async function vaultNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const held = await CIPHERS.getValue();
    if (!held) return names;
    const profile = held.profile as { organizations?: { id?: unknown; name?: unknown }[] };
    for (const organization of profile.organizations ?? []) {
        if (typeof organization.id !== "string") continue;
        if (typeof organization.name !== "string" || organization.name === "") continue;
        names.set(organization.id, organization.name);
    }
    return names;
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
        uris,
        // Already read a few lines up to choose the key this was decrypted with;
        // kept here so the list can say which vault a row came out of.
        organizationId:
            typeof cipher["organizationId"] === "string" ? cipher["organizationId"] : null
    };
}

/** Every login this account can open, decrypted. */
async function logins(): Promise<Login[]> {
    const [held, opened] = await Promise.all([CIPHERS.getValue(), vault()]);
    if (!held || !opened) return [];
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
    // Before anything is matched or counted: a site somebody has shut this out of
    // produces no suggestions, no badge and nothing to fill, which is the whole
    // point of having said so.
    if (isBlockedHost(await BLOCKED.getValue(), url)) return [];
    return rankForPage(await logins(), url);
}

/** The site in front of somebody, and whether they have shut this out of it. */
async function blockedHere(): Promise<{ host: string | null; blocked: boolean }> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? "";
    if (!/^https?:/i.test(url)) return { host: null, blocked: false };
    return { host: hostOf(url), blocked: isBlockedHost(await BLOCKED.getValue(), url) };
}

function summarize(login: Login, vaults: ReadonlyMap<string, string>): messages.ItemSummary {
    return {
        id: login.id,
        name: login.name,
        username: login.username,
        host: displayHost(login.uris),
        totp: login.totp !== null,
        // Null for this account's own vault, and null too for a shared one whose
        // name did not arrive - an unnamed row is honest where "Shared" would be
        // a label nobody chose.
        vault: login.organizationId === null ? null : (vaults.get(login.organizationId) ?? null)
    };
}

/**
 * Whose account this is, from the credential the approval left behind.
 *
 * Asked once and kept. A failure is not cached, so a server that was briefly
 * unreachable is asked again next time rather than leaving the popup permanently
 * unable to name its own account - and a success is, so opening the popup
 * twenty times is one request rather than twenty.
 *
 * `/api/v1/me` needs no scope: holding a usable credential is already the proof
 * of the identity it reports. Nothing here can fail loudly - an extension that
 * cannot say who it is still fills logins perfectly well.
 */
async function readAccount(): Promise<messages.ExtensionAccount | null> {
    const held = await ACCOUNT.getValue();
    if (held) return held;
    const [key, origin] = await Promise.all([ACCOUNT_KEY.getValue(), currentOrigin()]);
    if (!key || !origin) return null;
    try {
        const reply = await fetch(`${origin}/api/v1/me`, {
            headers: { authorization: `Bearer ${key}` },
            credentials: "omit"
        });
        if (!reply.ok) return null;
        const body = (await reply.json()) as { user?: { name?: unknown; email?: unknown } };
        const name = typeof body.user?.name === "string" ? body.user.name : null;
        const email = typeof body.user?.email === "string" ? body.user.email : null;
        // Neither half is worth keeping on its own account of nothing: a record
        // with two nulls in it says the same as no record and costs a read.
        if (name === null && email === null) return null;
        const account: messages.ExtensionAccount = { name, email };
        await ACCOUNT.setValue(account);
        return account;
    } catch {
        return null;
    }
}

/**
 * The account in front, as a record that can be set aside.
 *
 * Null when there is no session to park - no address, or no token - which is the
 * state right after signing out and while somebody is adding their second account.
 */
async function activeAccount(): Promise<accounts.ParkedAccount | null> {
    const [origin, email, refresh, wrapped, accountKey, who] = await Promise.all([
        currentOrigin(),
        EMAIL.getValue(),
        REFRESH.getValue(),
        WRAPPED.getValue(),
        ACCOUNT_KEY.getValue(),
        ACCOUNT.getValue()
    ]);
    if (!origin || !refresh) return null;
    return {
        id: accounts.accountId(origin, email),
        origin,
        email,
        name: who?.name ?? null,
        refresh,
        wrapped,
        accountKey
    };
}

/**
 * Set the account in front aside, keys included, leaving `rest` parked beside it.
 *
 * The vault key moves to `parkedVaults` and `open` is dropped in the same breath,
 * because the one thing that must never happen here is the outgoing account's key
 * still being live when the incoming account's items are read - that is one
 * person's master key opening another person's vault.
 */
async function parkActive(rest: readonly accounts.ParkedAccount[]): Promise<void> {
    // Before anything moves: a request opened by the account being set aside is
    // answered into whichever account is in front when the approval lands, and
    // that is about to stop being this one.
    await abandonRequest();
    const active = await activeAccount();
    if (!active) {
        await PARKED.setValue([...rest]);
        return;
    }
    if (open) parkedVaults.set(active.id, { vault: open, lockAt: await LOCK_AT.getValue() });
    open = null;
    await PARKED.setValue(accounts.parkAccount(rest, active));
}

/**
 * Forget the parked record for an account, and any key held with it.
 *
 * An account is in front or it is set aside, never both. The two ways it can end
 * up as both are signing into an account that is already parked - which keeps the
 * address, so it is one press away - and being switched to. Either leaves a row
 * nothing on screen can distinguish from the active one, holding a refresh token
 * that has been superseded, and sign-out promotes exactly that row: the account
 * somebody just left comes straight back, with the older token.
 */
async function dropParked(id: string): Promise<void> {
    parkedVaults.delete(id);
    const move = accounts.takeAccount(await PARKED.getValue(), id);
    if (move) await PARKED.setValue(move.rest);
}

/**
 * Leave no session behind: every place the worker keeps one, emptied together.
 *
 * One list rather than two. There were two - signing out and adding an account
 * clear the same things and differ only over the address - and the pair had
 * already drifted apart on what they did with a request still in flight. A way out
 * of an account that forgets one item is a browser still holding part of a session
 * nobody is in.
 *
 * The address is deliberately not here, because it is the one thing the two ways
 * out disagree about: signing out forgets it, adding an account keeps it so the
 * second sign-in lands on the button rather than back at the address.
 */
async function clearActive(): Promise<void> {
    open = null;
    await abandonRequest();
    await Promise.all([
        LOCK_AT.setValue(null),
        REFRESH.setValue(null),
        ACCESS.setValue(null),
        WRAPPED.setValue(null),
        CIPHERS.setValue(null),
        SYNCED_AT.setValue(null),
        REVISION.setValue(null),
        EMAIL.setValue(null),
        ACCOUNT_KEY.setValue(null),
        ACCOUNT.setValue(null)
    ]);
}

/**
 * Put a parked account in front, in every place the worker reads one from.
 *
 * This is the whole switch. Nothing else in this file knows there is more than
 * one account: every read goes on asking the same storage items it always has,
 * and this is what changes what they answer.
 */
async function makeActive(account: accounts.ParkedAccount): Promise<void> {
    const held = parkedVaults.get(account.id);
    parkedVaults.delete(account.id);
    // A vault that ran out of time while it was parked comes back locked. Being
    // set aside is disuse, and the timeout is not suspended by looking away.
    const alive = held !== undefined && !hasExpired(Date.now(), held.lockAt);
    open = alive ? (held?.vault ?? null) : null;

    await Promise.all([
        rememberOrigin(account.origin),
        EMAIL.setValue(account.email),
        REFRESH.setValue(account.refresh),
        // Dropped rather than carried: an access token belongs to the stretch of
        // session it was minted for, and a fresh one is one refresh away.
        ACCESS.setValue(null),
        WRAPPED.setValue(account.wrapped),
        ACCOUNT_KEY.setValue(account.accountKey),
        // Only a record that carries a name is worth keeping. `readAccount` hands
        // back whatever is held without asking the server again, so caching a
        // half-record here - a parked account whose name never resolved, because
        // it was set aside before any popup opened or while the server was briefly
        // unreachable - would suppress that fetch for the rest of the session. The
        // switcher would then show an email address forever and never correct
        // itself, which is precisely the thing this change exists to fix. Null
        // sends it back to the server instead.
        ACCOUNT.setValue(
            account.name === null ? null : { name: account.name, email: account.email }
        ),
        // The outgoing account's items are cleared rather than left to be
        // overwritten by the next sync: between the two, a list drawn from them
        // would be one account's logins shown under another's name.
        CIPHERS.setValue(null),
        SYNCED_AT.setValue(null),
        REVISION.setValue(null),
        LOCK_AT.setValue(alive ? (held?.lockAt ?? null) : null)
    ]);
    // Whatever else named this account in the list goes with the switch. The
    // caller has usually taken it out already; what this catches is a row left
    // over from a sign-in that never went past here.
    await dropParked(account.id);
}

async function status(): Promise<messages.VaultStatus> {
    const [server, email, refreshToken, syncedAt, timeout, opened, parked] = await Promise.all([
        currentOrigin(),
        EMAIL.getValue(),
        REFRESH.getValue(),
        SYNCED_AT.getValue(),
        TIMEOUT.getValue(),
        vault(),
        PARKED.getValue()
    ]);
    // Only worth asking for once there is a session to ask about: a browser that
    // has not been let in yet would spend a request on every poll of a screen
    // that is showing it the sign-in button.
    const account = refreshToken === null ? null : await readAccount();
    const activeId =
        server !== null && refreshToken !== null ? accounts.accountId(server, email) : null;

    // The parked ones first and the active one last, so the list keeps the order
    // accounts were set aside in rather than reshuffling under somebody's cursor
    // every time they switch.
    const known: messages.AccountRef[] = parked.map((one) => ({
        id: one.id,
        name: one.name,
        email: one.email,
        origin: one.origin
    }));
    if (server !== null && activeId !== null) {
        known.push({ id: activeId, name: account?.name ?? null, email, origin: server });
    }

    return {
        server,
        email,
        connected: refreshToken !== null,
        unlocked: opened !== null,
        syncedAt,
        timeoutMs: readTimeout(timeout),
        accounts: known,
        activeId
    };
}

/**
 * The address this vault belongs to, from the profile that just came down.
 *
 * Recorded on every sync rather than only where somebody typed it, because it is
 * what the master password is stretched with: a session that began with an approval
 * never typed one, and without this the first time the vault locks itself is the
 * last time it can be opened. Kept lowercased, which is the form the derivation
 * salts with and the form the password grant already writes - so both ways in
 * produce the same key from the same password.
 */
async function rememberEmail(profile: Record<string, unknown>): Promise<void> {
    const found = profile["email"];
    if (typeof found !== "string") return;
    const email = found.trim().toLowerCase();
    if (email === "" || email === (await EMAIL.getValue())) return;
    await EMAIL.setValue(email);
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
        ...(moved !== null ? [REVISION.setValue(moved)] : []),
        rememberEmail(fresh.profile)
    ]);
    // The profile arrived with it, and it is what the other vaults' keys are read
    // from - so an open vault that started without them has them now.
    const opened = await vault();
    if (opened) open = { key: opened.key, organizations: await organizationKeys(opened.key) };
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
        const text =
            (await vault()) && /^https?:/i.test(url)
                ? String((await forUrl(url)).length || "")
                : "";
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
    const pass =
        inputs.find(
            (field) => field.type === "password" && field.autocomplete !== "new-password"
        ) ?? null;
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
    if (isBlockedHost(await BLOCKED.getValue(), tab.url)) {
        return { ok: false, error: "This extension is switched off for this site." };
    }
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

/**
 * The requests that count as somebody using the vault, and so move its deadline.
 *
 * A badge redrawn because a tab changed is deliberately not on this list: the
 * timeout measures disuse, and browsing with the popup closed is exactly the disuse
 * it is there to measure.
 */
const USES_VAULT = new Set<messages.Request["kind"]>([
    "signIn",
    "unlock",
    "switchAccount",
    "sync",
    "items",
    "itemsFor",
    "fill",
    "copy",
    "totpNow",
    "save",
    "changePassword"
]);

/**
 * Save a new login into the account's OWN vault.
 *
 * Which vault is not a parameter, and that is deliberate rather than unfinished:
 * writing into a shared one means choosing a collection and holding the key for
 * it, and an extension that guessed would put a password somewhere other people
 * can read it. The Polaris screens are where an item goes into a shared vault,
 * and moving one there re-encrypts it under that vault's key.
 *
 * What was typed is checked again here with the same function the popup used. The
 * popup's copy is so the button can say why it is disabled; this one is the one
 * that decides, because a caller is not where a decision is allowed to be final.
 */
async function save(item: {
    readonly name: string;
    readonly username: string;
    readonly password: string;
    readonly uri: string;
}): Promise<messages.Reply> {
    const opened = await vault();
    if (!opened) return { ok: false, error: "The vault is locked." };

    const intent = readIntendedLogin(item);
    if (!intent.ok) return { ok: false, error: intent.error };

    const origin = await currentOrigin();
    if (!origin) return { ok: false, error: "Say which Polaris this is first." };
    const base = vaultBase(origin);
    const access = await token(base);
    if (!access) return { ok: false, error: "That server did not answer. Sign in again." };

    const { login } = intent;
    const key = opened.key;
    const outcome = await protocol.createLogin(base, access, {
        type: CIPHER_LOGIN,
        name: await encrypt(login.name, key),
        login: {
            username: login.username === null ? null : await encrypt(login.username, key),
            password: login.password === null ? null : await encrypt(login.password, key),
            // Omitted rather than sent empty: a login saved for no page should have
            // no address, not one that matches nothing and shows as a blank row.
            ...(login.uri === null
                ? {}
                : { uris: [{ uri: await encrypt(login.uri, key), match: null }] })
        }
    });

    if (!outcome.ok) {
        if (outcome.status === null)
            return { ok: false, error: "That server could not be reached." };
        if (outcome.status === 401)
            return { ok: false, error: "That session has ended. Sign in again." };
        // A 400 here is this client having built the item wrong, which is a defect
        // rather than something the reader can act on - so it is logged with the
        // status and they are told the one useful thing: nothing was saved.
        console.error("polaris: the vault refused a new item, status", outcome.status);
        return { ok: false, error: "That could not be saved." };
    }

    // Straight away rather than on the next poll: the item somebody just saved has
    // to be in the list they are looking at, and the badge has to count it.
    await sync(true);
    return { ok: true, status: await status() };
}

/**
 * Change one login's password, keeping the rest of the item byte for byte.
 *
 * The vault takes an item whole, so the danger here is not the write failing - it
 * is the write succeeding and quietly emptying every field this extension does not
 * model. A login can carry notes, custom fields, an attachment key and a password
 * history; rebuilding one from the reduced shape `readLogin` produces would send
 * nulls for all of them, and nothing on any screen would say so.
 *
 * So the item that goes out is the one that came down from `api/sync`, still
 * encrypted, with three things replaced. Nothing is decrypted to do this except
 * the password being written, and the old one is never decrypted at all: it moves
 * into the history as the ciphertext it already was.
 */
async function changePassword(id: string, password: string): Promise<messages.Reply> {
    const opened = await vault();
    if (!opened) return { ok: false, error: "The vault is locked." };
    if (password === "") return { ok: false, error: "Type the new password first." };

    const held = await CIPHERS.getValue();
    const item = held?.ciphers.find((one) => one["id"] === id);
    if (!item) return { ok: false, error: "That item is not here. Sync and try again." };
    const key = keyFor(item);
    if (!key) return { ok: false, error: "This vault does not hold the key for that item." };

    const origin = await currentOrigin();
    if (!origin) return { ok: false, error: "Say which Polaris this is first." };
    const base = vaultBase(origin);
    const access = await token(base);
    if (!access) return { ok: false, error: "That server did not answer. Sign in again." };

    // What goes out is built by `lib/item.ts`: the item as it arrived, with the
    // password replaced, the old one moved into its history and the revision this
    // browser last saw attached. It is a module of its own and under test because
    // the vault takes an item whole, so a field left out of it is a field deleted
    // from somebody's vault by a save that reported success.
    const rewritten = withNewPassword(item, await encrypt(password, key), new Date().toISOString());
    const outcome = await protocol.updateLogin(base, access, id, rewritten);

    if (!outcome.ok) {
        if (outcome.status === null)
            return { ok: false, error: "That server could not be reached." };
        if (outcome.status === 401)
            return { ok: false, error: "That session has ended. Sign in again." };
        if (outcome.status === 409) {
            // Somebody else saved it first. Bring their version down before saying
            // so, because the next thing anybody does is look at the item - and it
            // should be showing what is actually stored by then.
            await sync(true);
            return {
                ok: false,
                error: "Somebody changed this item elsewhere. It has been refreshed; try again."
            };
        }
        console.error("polaris: the vault refused an item update, status", outcome.status);
        return { ok: false, error: "That could not be saved." };
    }

    await sync(true);
    return { ok: true, status: await status() };
}

/** How often the server is asked whether a newer extension has been published.
 *  Twice a day: the answer changes a few times a year. */
const UPDATE_EVERY_MINUTES = 12 * 60;

/** Long enough for a server on the other side of a tunnel, short enough that a
 *  worker is not held open by it. */
const UPDATE_TIMEOUT_MS = 10_000;

/**
 * Ask this Polaris whether a newer extension is out, and remember the answer.
 *
 * The server rather than GitHub, and that is the whole shape of this: the
 * manifest declares no host permission at all, the one origin this extension may
 * reach is the one somebody named, and the dashboard already makes and caches
 * this exact lookup for its own downloads page. Asking GitHub from here would
 * mean a password manager standing on permission to reach a second host, for a
 * version number.
 *
 * How it got here is read at the same moment, because that is what decides what
 * the popup says: a store install is updated by the store, and a copy loaded from
 * disk has to be loaded again. `management.getSelf` is the one method of that API
 * which needs no permission; if it refuses anyway, `noticeFor` reads the absent
 * answer as the manual case, which is the direction that leaves nobody waiting
 * for an update that is never coming.
 *
 * Never throws, and never withdraws a notice it could not re-confirm: it runs
 * from an alarm, and a server that was briefly unreachable is not news that the
 * extension is suddenly current.
 */
async function checkForUpdate(): Promise<void> {
    const origin = await currentOrigin();
    if (!origin) return;
    try {
        const response = await fetch(`${origin}/api/polaris/extension`, {
            signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
            credentials: "omit"
        });
        if (!response.ok) return;
        const answer = (await response.json()) as { version?: unknown; url?: unknown };
        const self = await browser.management.getSelf().catch(() => null);
        await UPDATE.setValue(
            noticeFor(answer, browser.runtime.getManifest().version, self?.installType)
        );
    } catch {
        // Unreachable, or an answer that was not JSON. What is stored stands.
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
                // Checked, never requested: asking is the popup's job because only
                // a user gesture may ask, and this worker has none. What is left
                // here is the decision - a caller saying it was granted is not
                // the same as the browser having granted it.
                if (!(await holdsOrigin(origin))) {
                    return {
                        ok: false,
                        error: "Without permission for that address, nothing can be read from it."
                    };
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
                        return {
                            ok: false,
                            error: "Enter the code from your authenticator.",
                            needsCode: true
                        };
                    }
                    if (result.kind === "rate_limited") {
                        const minutes = Math.ceil(result.retryAfterMs / 60_000);
                        return {
                            ok: false,
                            error: `Too many attempts. Try again in ${minutes} minutes.`
                        };
                    }
                    if (result.kind === "unreachable") {
                        return { ok: false, error: "That server could not be reached." };
                    }
                    return {
                        ok: false,
                        error: "That address and password did not open the vault."
                    };
                }

                await EMAIL.setValue(email);
                await remember(result.token);
                // Signed in and open in one step: the password is in hand, and
                // asking for it again immediately would be theatre.
                await sync(true);
                await unlock(request.password);
                // Signing back into an account that is still parked - which is one
                // press, because adding an account keeps the address - would leave
                // it in the list as well as in front, with the older token.
                await dropParked(accounts.accountId(origin, email));
                await badge();
                return { ok: true, status: await status() };
            }

            case "authorize": {
                const origin = await currentOrigin();
                if (!origin) return { ok: false, error: "Say which Polaris this is first." };
                // A pair for this one exchange. The public half goes to the server;
                // the private half stays here and is the only thing that can open
                // what comes back.
                const pair = await generateRsaKeyPair();
                const opened = await protocol.openAuthorization(vaultBase(origin), {
                    publicKey: pair.publicKey,
                    device: await device()
                });
                if (!opened) return { ok: false, error: "That server did not answer." };

                // Whatever pair this replaces is unreachable the moment it is
                // overwritten, so its private half is zeroed first rather than left
                // in memory with nothing referring to it - which is the care the
                // collecting takes on both of its own paths.
                asking?.privateKey.fill(0);
                asking = { publicKey: pair.publicKey, privateKey: pair.privateKey };
                await WAITING.setValue({
                    deviceCode: opened.deviceCode,
                    userCode: opened.userCode,
                    pollMs: opened.pollMs,
                    until: readExpiry(opened.expiresAt),
                    state: "pending"
                });
                // Waited on here, before the tab exists. Opening it is what closes
                // the popup, so this worker is the only thing that can still be
                // listening by the time somebody presses yes.
                startCollecting();
                // Opened here rather than left to the popup: a popup is torn down
                // the moment it loses focus, which is exactly what opening a tab
                // does to it.
                await browser.tabs.create({
                    url: `${origin}/vault/authorize?code=${encodeURIComponent(opened.userCode)}`
                });
                return {
                    ok: true,
                    waiting: "pending",
                    userCode: opened.userCode,
                    pollMs: opened.pollMs
                };
            }

            case "authorizeCheck": {
                const waiting = await WAITING.getValue();
                if (!waiting) {
                    return {
                        ok: true,
                        waiting: "none",
                        userCode: null,
                        pollMs: protocol.DEFAULT_POLL_MS
                    };
                }
                const { state, userCode, pollMs } = waiting;
                // Read, never asked of the server here. The loop above is what polls,
                // and a second poller would spend the same claim budget twice as fast
                // for an approval only one of them could be handed.
                if (state === "pending") {
                    // A worker that came back since has no loop running; starting it
                    // is what turns that into an answer rather than a wait nothing
                    // will ever end.
                    startCollecting();
                    return { ok: true, waiting: "pending", userCode, pollMs };
                }

                // Reported once and then forgotten, because every state below is an
                // end: what follows is asking again, not waiting longer.
                await WAITING.setValue(null);
                if (state === "lost") {
                    return { ok: false, error: "This browser lost the request. Ask again." };
                }
                if (state === "unreadable") {
                    return { ok: false, error: "What came back could not be opened. Ask again." };
                }
                return { ok: true, waiting: state, userCode, pollMs };
            }

            case "authorizeCancel": {
                // The key material goes with the request: somebody who cancelled is
                // not waiting on it, and the loop stops on its next look.
                await abandonRequest();
                return { ok: true };
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
                // The other accounts' keys with it. This is a demand rather than a
                // deadline, and a switch that landed straight inside another vault
                // would answer a different question than the one the button asks:
                // being set aside is disuse, and so is being locked.
                parkedVaults.clear();
                await LOCK_AT.setValue(null);
                await badge();
                return { ok: true, status: await status() };

            case "signOut": {
                // Which account is leaving, read before anything is cleared - its
                // key must not stay in the map for a session that has ended.
                const leaving = await activeAccount();
                if (leaving) parkedVaults.delete(leaving.id);
                // Anything in flight goes too: a request still being collected
                // would hand this browser back into an account somebody has just
                // signed out of.
                await clearActive();
                await forgetOrigin();

                // Signing out of one account is not signing out of the rest. The
                // next one parked takes its place, because somebody with two
                // accounts who leaves one means to be left in the other - and the
                // alternative is a switcher that empties itself on the way past.
                const waitingAccounts = await PARKED.getValue();
                const next = waitingAccounts[0];
                if (next) {
                    await PARKED.setValue(waitingAccounts.slice(1));
                    await makeActive(next);
                    await sync(true);
                }
                await badge();
                return { ok: true, status: await status() };
            }

            case "switchAccount": {
                const parked = await PARKED.getValue();
                const move = accounts.takeAccount(parked, request.id);
                // Asked for an account that is not here: a second window can have
                // signed out of it since this popup drew its list.
                if (!move) return { ok: false, error: "That account is not signed in here." };
                await parkActive(move.rest);
                await makeActive(move.taken);
                // Its items were cleared with the switch, so they are fetched now
                // rather than leaving somebody looking at an empty vault until
                // they think to press Sync.
                await sync(true);
                await badge();
                return { ok: true, status: await status() };
            }

            case "addAccount": {
                // Set aside rather than signed out: the point is a second account,
                // and the first has to still be there to go back to.
                await parkActive(await PARKED.getValue());
                await clearActive();
                // The address is deliberately kept, so this lands on "Sign in with
                // Polaris" rather than on "which Polaris". A second account is
                // usually on the same server, and clearing it would spend a
                // permission prompt asking for an origin the browser has already
                // granted - a browser allows one request per gesture.
                await badge();
                return { ok: true, status: await status() };
            }

            case "forgetServer": {
                // Refused while somebody is signed in, because the session would be
                // left with no address to reach its own server at.
                if (await REFRESH.getValue()) {
                    return { ok: false, error: "Sign out of this account first." };
                }
                await forgetOrigin();
                return { ok: true, status: await status() };
            }

            case "sync":
                return (await sync(true))
                    ? { ok: true, status: await status() }
                    : { ok: false, error: "Nothing came back from that server." };

            case "itemsFor": {
                const vaults = await vaultNames();
                return {
                    ok: true,
                    items: (await forUrl(request.url)).map((login) => summarize(login, vaults))
                };
            }

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
                {
                    const vaults = await vaultNames();
                    return {
                        ok: true,
                        items: found.slice(0, 100).map((login) => summarize(login, vaults))
                    };
                }
            }

            case "totpNow": {
                // Computed here and handed over as six digits with the seconds
                // left, so the secret stays in this worker and the popup holds
                // only something that expires on its own.
                const login = (await logins()).find((one) => one.id === request.id);
                if (!login?.totp) return { ok: false, error: "That item has no one-time code." };
                const code = await totpCode(login.totp);
                if (!code) return { ok: false, error: "That authenticator value cannot be read." };
                return { ok: true, code, remaining: totpRemaining(login.totp) };
            }

            case "blocked":
                return { ok: true, ...(await blockedHere()) };

            case "updateStatus":
                // Read, never checked here: the popup asking is not a reason to
                // make a request, and the alarm is what keeps this current.
                return { ok: true, update: await UPDATE.getValue() };

            case "setTimeout": {
                const chosen = readTimeout(request.timeoutMs);
                await TIMEOUT.setValue(chosen);
                // Applied to the vault that is open right now rather than at the
                // next use: somebody who has just shortened this means it, and
                // leaving the standing deadline alone would keep the vault open for
                // exactly the length they were trying to get away from.
                if (open) await LOCK_AT.setValue(deadlineFrom(Date.now(), chosen));
                return { ok: true, status: await status() };
            }

            case "setBlocked": {
                const { host } = await blockedHere();
                if (!host) return { ok: false, error: "There is no site here to switch off." };
                const held = await BLOCKED.getValue();
                const without = held.filter((entry) => entry !== host);
                await BLOCKED.setValue(request.blocked ? [...without, host] : without);
                await badge();
                return { ok: true, ...(await blockedHere()) };
            }

            case "fill":
                return fill(request.id);

            case "save":
                return save(request);

            case "changePassword":
                return changePassword(request.id, request.password);

            case "copy": {
                const login = (await logins()).find((one) => one.id === request.id);
                if (!login) return { ok: false, error: "That item is not open." };
                // The popup writes to the clipboard itself, from the gesture that
                // asked for it: a worker has no document to copy from, and the
                // value crosses to a page of ours rather than to a web page.
                // The code, never the secret. `login.totp` is the `otpauth` value
                // the vault stores, and handing that over as "the code" was a
                // button that copied something no site will accept - and that
                // somebody might then paste somewhere it does not belong.
                const value =
                    request.field === "username"
                        ? login.username
                        : request.field === "password"
                          ? login.password
                          : login.totp
                            ? await totpCode(login.totp)
                            : null;
                return value
                    ? { ok: true, value }
                    : { ok: false, error: "There is nothing to copy." };
            }
        }
    };

    // Answered through the callback, with `return true` to hold the channel open -
    // never by returning the promise. Firefox accepts a returned promise here;
    // Chrome ignores it and closes the channel immediately, so every request the
    // popup ever made would resolve to `undefined` and the extension would look
    // like it does nothing at all. WXT ships no polyfill over that difference:
    // `browser` is the native object.
    // Answered first, and only then is the deadline moved. After rather than
    // before, because a request that arrives past the deadline has to find the
    // vault locked: pushing it forward first would mean the act of asking kept the
    // vault open, which is every timeout undone by the thing it was measuring.
    const answerAndTouch = async (): Promise<messages.Reply> => {
        const reply = await answer();
        if (USES_VAULT.has(request.kind)) await touch();
        return reply;
    };

    void answerAndTouch()
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
    if (command !== "fill-login" || !(await vault())) return;
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

/** The id the inline script is registered under, so the old registration can be
 *  found and replaced rather than piling up. */
const AUTOFILL_ID = "polaris-autofill";

/**
 * Keep the inline login script registered for the sites somebody has granted.
 *
 * The script is built as an unlisted file with no manifest entry, so nothing is
 * injected anywhere until this runs - which is what lets the extension offer
 * filling inside a page while still asking, at install time, for access to no
 * site at all. What it may run on is `injectableOrigins`, and the rule that a
 * broad grant is never registered on lives there.
 *
 * The old registration is removed first: registering an id that already exists
 * fails the whole call rather than replacing it, so a worker that came back
 * would otherwise register nothing and say nothing.
 *
 * Firefox gets no inline filling for now. Manifest v2 has no `scripting`
 * namespace, and the check below is what makes that a feature this browser does
 * not have rather than a worker that throws on startup and takes the vault with
 * it. Everything else - the popup, the keyboard fill - is unaffected.
 */
async function syncAutofill(): Promise<void> {
    if (!browser.scripting?.registerContentScripts) return;
    const [held, home] = await Promise.all([
        browser.permissions.getAll().catch(() => ({ origins: [] as string[] })),
        currentOrigin()
    ]);
    const matches = injectableOrigins(held.origins ?? [], home);

    await browser.scripting.unregisterContentScripts({ ids: [AUTOFILL_ID] }).catch(() => undefined);
    if (matches.length === 0) return;
    await browser.scripting
        .registerContentScripts([
            {
                id: AUTOFILL_ID,
                js: ["autofill.js"],
                matches,
                runAt: "document_idle",
                persistAcrossSessions: true
            }
        ])
        .catch(() => undefined);
}

export default defineBackground(() => {
    // The sites this may run inside, kept current. Once at startup because a
    // grant made while the worker was recycled is one nothing else would notice,
    // and on every change because the browser's own extension settings page can
    // give and take access without this extension being asked.
    void syncAutofill();
    browser.permissions.onAdded.addListener(() => void syncAutofill());
    browser.permissions.onRemoved.addListener(() => void syncAutofill());

    // Registered here rather than beside the others above, and not by preference:
    // WXT evaluates this module during the build against a stand-in browser that
    // implements no `commands`, so a top-level registration throws there and takes
    // the build with it. Inside this function it runs when the worker starts,
    // which is still synchronous registration - what manifest v3 requires of a
    // listener that has to survive the worker being recycled.
    browser.commands.onCommand.addListener((command) => void fillFromKeyboard(command));

    // The deadline is enforced on a period, not only when something asks. On
    // Firefox nothing else would: a persistent background page goes on holding the
    // key with no request ever arriving, so a vault left open at lunchtime has to
    // lock itself. A minute is finer than the shortest length on offer, and on
    // manifest v3 this mostly finds the worker was recycled long ago - which is the
    // same lock, arrived at for free.
    browser.alarms.create("vault-lock", { periodInMinutes: 1 });
    // And a far slower one, for a question whose answer changes a few times a
    // year. An extension loaded by hand never updates itself, so this is the only
    // thing that would ever tell somebody they are months behind.
    browser.alarms.create("update-check", { periodInMinutes: UPDATE_EVERY_MINUTES });
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === "update-check") {
            void checkForUpdate();
            return;
        }
        if (alarm.name !== "vault-lock") return;
        void (async () => {
            const wasOpen = open !== null;
            // `vault()` is what locks it; this only has to notice that it did, so
            // the badge stops offering counts for a vault nobody can read.
            if (!(await vault()) && wasOpen) await badge();
            // The accounts set aside keep their own deadlines, and nothing else
            // ever looks at them: a switch that never comes refuses an expired
            // vault it is not holding, which is not the same as not holding it.
            sweepParkedVaults(Date.now());
            // And a request somebody went off to approve is collected by a loop in
            // this worker, which a recycle takes with it. Restarted here so it
            // reaches an answer - it finds the private half gone and says so -
            // rather than leaving a code waiting on nothing.
            if (await WAITING.getValue()) startCollecting();
        })();
    });

    // Nothing else to do on install. The keys are not here yet and asking for them
    // before somebody opens the popup would be asking the browser to hold a
    // master password, which is the one thing this design refuses.
    void badge();
    // Except this, which needs no key and nothing typed: a browser that starts
    // once a day would otherwise wait for the alarm's whole period before finding
    // out anything at all.
    void checkForUpdate();
});
