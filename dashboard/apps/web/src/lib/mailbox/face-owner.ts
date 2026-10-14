/**
 * Whose face an address is, among the people on this Polaris.
 *
 * A message from a colleague should carry the picture they chose here, the same
 * one their messages carry in Chat - whichever of their addresses it was sent
 * from. So an address is matched against every way it can belong to an account,
 * and only the ways that prove it does:
 *
 * - **The address they sign in with**, once it is verified. An unverified one is
 *   only somebody's say-so, and the face it would put on a stranger's mail is
 *   exactly the impersonation this must not hand out.
 * - **Their other addresses** (`UserEmail`), once each is verified. Adding an
 *   address is free; proving it is what makes it theirs.
 * - **A mailbox on a mail server this Polaris runs**, that they have signed in
 *   to. The server checked the password, so holding the mailbox is proven in a
 *   way an outside IMAP host - which may be one the person runs themselves and
 *   which accepts anything - never can be. Identities ("send as") are left out
 *   for the same reason: anybody can type one.
 *
 * An address two accounts can prove - a shared support mailbox handed to three
 * people - is nobody's face, because picking one would be a guess.
 *
 * Then the privacy rule, the same one every other face in Polaris answers to
 * (`maySee` on `avatar`). Somebody who keeps their picture to themselves is,
 * as far as Mail is concerned, an address with no account behind it: the reader
 * gets whatever a stranger at that address would get, so the answer never says
 * that there is anybody here to hide.
 *
 * Both questions are remembered for a minute. A mailbox asks for a face per row
 * and is opened all day, and a minute is short enough that somebody who changes
 * who may see their picture is obeyed before they have finished checking.
 */

import { prisma } from "@polaris/db";
import { maySee, type PrivacyViewer } from "@/lib/privacy-service";
import { createGate, createSharedFlight } from "@/lib/concurrency-gate";
import { gravatarEnabled, gravatarImage, type GravatarAnswer } from "@/lib/avatar-service";

/** How long an answer stands, owner and visibility alike. */
const REMEMBER_MS = 60_000;

/** Past this many remembered answers the memo starts over rather than grow
 *  without bound on an instance that receives mail from the whole world. */
const MAX_REMEMBERED = 5_000;

/** How many rows one address may match before the rest are not read. Two is
 *  already "more than one account", which is the only thing past one that
 *  matters; a few more cover the same person holding it twice. */
const MATCH_LIMIT = 10;

interface Memo<T> {
    readonly at: number;
    readonly value: T;
}

/** Held on `globalThis` for the same reason the mark cache is: a dev server
 *  re-evaluates the module and a fresh map would forget every answer. */
const OWNERS = Symbol.for("polaris.mail.face-owners");
const SIGHT = Symbol.for("polaris.mail.face-sight");

function memo<T>(key: symbol): Map<string, Memo<T>> {
    const held = globalThis as { [k: symbol]: Map<string, Memo<T>> | undefined };
    held[key] ??= new Map();
    return held[key];
}

function recall<T>(map: Map<string, Memo<T>>, key: string): Memo<T> | null {
    const found = map.get(key);
    if (!found) return null;
    if (Date.now() - found.at < REMEMBER_MS) return found;
    map.delete(key);
    return null;
}

function keep<T>(map: Map<string, Memo<T>>, key: string, value: T): void {
    if (map.size >= MAX_REMEMBERED) map.clear();
    map.set(key, { at: Date.now(), value });
}

/** Forget every remembered owner and visibility. For tests, and for anything
 *  that has to be obeyed sooner than a minute. */
export function forgetFaceOwners(): void {
    memo<string | null>(OWNERS).clear();
    memo<boolean>(SIGHT).clear();
}

/** A hundred rows from one colleague arriving together are one lookup. */
const sameAddress = createSharedFlight<string | null>();

/**
 * The account an address provably belongs to, or null.
 *
 * Matched without regard to case, because an address is written however the
 * sender's client felt like writing it and stored however the person typed it.
 * The database is asked case-insensitively and every row is then compared
 * exactly here, so a stored address with an `_` in it - which a pattern match
 * reads as "any character" - cannot stand in for somebody else's.
 */
export async function addressOwner(address: string): Promise<string | null> {
    const wanted = address.trim().toLowerCase();
    const at = wanted.lastIndexOf("@");
    if (at < 1 || at === wanted.length - 1) return null;

    const owners = memo<string | null>(OWNERS);
    const held = recall(owners, wanted);
    if (held) return held.value;

    return sameAddress(wanted, async () => {
        const owner = await lookUp(wanted, wanted.slice(0, at), wanted.slice(at + 1));
        keep(owners, wanted, owner);
        return owner;
    });
}

async function lookUp(address: string, local: string, domain: string): Promise<string | null> {
    const same = { equals: address, mode: "insensitive" as const };
    const [primaries, alternates, mailboxes] = await Promise.all([
        prisma.user.findMany({
            where: { email: same, emailVerified: true },
            select: { id: true, email: true },
            take: MATCH_LIMIT
        }),
        prisma.userEmail.findMany({
            where: { email: same, verifiedAt: { not: null } },
            select: { userId: true, email: true },
            take: MATCH_LIMIT
        }),
        prisma.mailAccount.findMany({
            where: { address: same, lastOkAt: { not: null } },
            select: { userId: true, address: true, username: true, imapHost: true },
            take: MATCH_LIMIT
        })
    ]);

    const found = new Set<string>();
    for (const row of primaries) if (row.email.toLowerCase() === address) found.add(row.id);
    for (const row of alternates) if (row.email.toLowerCase() === address) found.add(row.userId);

    // Only the mailboxes signed in as that address, on a server of ours that
    // hands out that domain. Asked only when there is a candidate, which for
    // almost every sender there is not.
    const signedIn = mailboxes.filter((row) => {
        const login = row.username.trim().toLowerCase();
        return row.address.toLowerCase() === address && (login === address || login === local);
    });
    if (signedIn.length > 0) {
        const servers = await prisma.mailServer.findMany({
            where: { status: "ready", primaryDomain: { equals: domain, mode: "insensitive" } },
            select: { hostname: true, primaryDomain: true }
        });
        const hosts = new Set(
            servers
                .filter((server) => server.primaryDomain.toLowerCase() === domain)
                .map((server) => server.hostname.trim().toLowerCase())
        );
        for (const row of signedIn) {
            if (hosts.has(row.imapHost.trim().toLowerCase())) found.add(row.userId);
        }
    }

    return found.size === 1 ? [...found][0]! : null;
}

/**
 * The account behind an address, when this viewer may see its picture - and
 * null when there is none or they may not, which are deliberately the same
 * answer.
 */
export async function visibleOwner(address: string, viewer: PrivacyViewer): Promise<string | null> {
    const owner = await addressOwner(address);
    if (!owner) return null;
    if (owner === viewer.id || viewer.isAdmin) return owner;

    const sight = memo<boolean>(SIGHT);
    const key = `${viewer.id}:${owner}`;
    const held = recall(sight, key);
    if (held) return held.value ? owner : null;

    const visible = await maySee(owner, "avatar", viewer);
    keep(sight, key, visible);
    return visible ? owner : null;
}

/** Gravatar lookups at once, across every reader: a cold mailbox asks for a
 *  face per row, and each of these is a request to somebody else's server. */
const gravatars = createGate(4);
const sameGravatar = createSharedFlight<GravatarAnswer>();

/**
 * What Gravatar has for an address, or null when it has nothing, the instance
 * does not use it, or the answer did not arrive in time.
 *
 * Asked by Polaris and never by the browser, and remembered by
 * `gravatarImage` itself - a picture and a "nobody here" alike - so this is a
 * request per address per day rather than per row per visit.
 */
export async function addressGravatar(
    address: string,
    signal?: AbortSignal
): Promise<GravatarAnswer | null> {
    if (!(await gravatarEnabled())) return null;
    const wanted = address.trim().toLowerCase();
    try {
        return await sameGravatar(
            wanted,
            (abandoned) => gravatars.run(() => gravatarImage(wanted), abandoned),
            signal
        );
    } catch {
        // Waited too long for a place. Not an answer about the address, so the
        // caller moves on to the next source and nothing is remembered.
        return null;
    }
}
