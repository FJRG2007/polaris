/**
 * Putting a note on the internet.
 *
 * A note published this way is reached by a URL and nothing else: whoever holds
 * it can read the page, and the page is all they can read. There is no session
 * behind it and no identity to check, so the token plus whatever the owner
 * narrowed it with IS the credential - and that is exactly the shape a Drive
 * share already has here, so this uses the same guards rather than a second set
 * written for notes. A fix to `lib/link-guards` reaches this the day it lands.
 *
 * What is deliberately not here: writing. Somebody outside Polaris wants to read
 * a page; letting them change it would need an identity Polaris does not have for
 * them, and an editable document open to the internet is an editable document
 * open to the internet.
 *
 * The token exists in the URL and nowhere else in the clear. What the database
 * holds is its hash, plus the token sealed under the master key so the owner can
 * be shown the link again - a dump alone yields no working links either way.
 */

import * as access from "./access";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import type { NoteShareInput } from "@polaris/core";
import { sharingBaseUrl } from "@/lib/domain-service";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";
import {
    linkUsability,
    signUnlock,
    unlockCookieName,
    verifyUnlock,
    type LinkUsability
} from "@/lib/link-guards";

/** The cookie namespace a solved note password is signed under. */
const NOTE_LINK_SCOPE = "note";

/** A published note as its owner sees it. The token is not in here: it is
 *  returned once when the link is made, and revealed on request. */
export interface NoteShareView {
    readonly includeChildren: boolean;
    readonly hasPassword: boolean;
    readonly maxViews: number | null;
    readonly viewCount: number;
    readonly allowedCidrs: readonly string[];
    readonly allowedCountries: readonly string[];
    readonly allowedContinents: readonly string[];
    readonly expiresAt: string | null;
    readonly createdAt: string;
    /** Why it cannot be opened right now, when that is the case. */
    readonly usable: LinkUsability;
}

const VIEW_SELECT = {
    id: true,
    includeChildren: true,
    passwordHash: true,
    maxViews: true,
    viewCount: true,
    allowedCidrs: true,
    allowedCountries: true,
    allowedContinents: true,
    expiresAt: true,
    revokedAt: true,
    createdAt: true
} as const;

type ShareRow = {
    includeChildren: boolean;
    passwordHash: string | null;
    maxViews: number | null;
    viewCount: number;
    allowedCidrs: string;
    allowedCountries: string;
    allowedContinents: string;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
};

function list(json: string): string[] {
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

function toView(share: ShareRow): NoteShareView {
    return {
        includeChildren: share.includeChildren,
        hasPassword: share.passwordHash !== null,
        maxViews: share.maxViews,
        viewCount: share.viewCount,
        allowedCidrs: list(share.allowedCidrs),
        allowedCountries: list(share.allowedCountries),
        allowedContinents: list(share.allowedContinents),
        expiresAt: share.expiresAt?.toISOString() ?? null,
        createdAt: share.createdAt.toISOString(),
        usable: linkUsability({
            revokedAt: share.revokedAt,
            expiresAt: share.expiresAt,
            maxUses: share.maxViews,
            useCount: share.viewCount
        })
    };
}

/** The address a published note lives at. The sharing hostname rather than the
 *  dashboard's, which is the one every other public link in Polaris uses. */
export async function noteShareUrl(token: string): Promise<string> {
    return `${(await sharingBaseUrl()).replace(/\/+$/, "")}/n/${token}`;
}

/** The link on a note, if it has one. Reading it needs whatever reading the note
 *  needs; changing it needs more, which is the next function's business. */
export async function getNoteShare(
    actor: access.NoteActor,
    noteId: string
): Promise<NoteShareView | null> {
    await access.requireNote(actor, noteId, "guest");
    const share = await prisma.noteShare.findUnique({ where: { noteId }, select: VIEW_SELECT });
    return share ? toView(share) : null;
}

/**
 * Publish a note, or change how it is published.
 *
 * Publishing is a member's act rather than a guest's: somebody who may read a
 * notebook must not be able to put its pages on the internet. The token is minted
 * once, on the first call, and every later call changes the limits around it -
 * so turning a password on does not hand out a new URL and invalidate the one
 * people already have.
 */
export async function publishNote(
    actor: access.NoteActor,
    noteId: string,
    input: NoteShareInput
): Promise<{ url: string; share: NoteShareView }> {
    await access.requireNote(actor, noteId, "member");

    const existing = await prisma.noteShare.findUnique({
        where: { noteId },
        select: { id: true, passwordHash: true }
    });

    const limits = {
        includeChildren: input.includeChildren,
        allowedCidrs: JSON.stringify(input.allowedCidrs),
        allowedCountries: JSON.stringify(input.allowedCountries),
        allowedContinents: JSON.stringify(input.allowedContinents),
        maxViews: input.clearMaxViews ? null : (input.maxViews ?? undefined),
        expiresAt: input.clearExpiry ? null : (input.expiresAt ?? undefined),
        // A new password replaces the old one; `clearPassword` takes it off; and
        // sending neither leaves whatever is there, so saving the other settings
        // does not quietly unlock the link.
        passwordHash: input.password
            ? await hashLinkPassword(input.password)
            : input.clearPassword
              ? null
              : undefined
    };

    if (existing) {
        const share = await prisma.noteShare.update({
            where: { noteId },
            data: limits,
            select: VIEW_SELECT
        });
        return { url: await revealNoteShare(actor, noteId), share: toView(share) };
    }

    const token = generateToken();
    const sealed = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    const share = await prisma.noteShare.create({
        data: {
            noteId,
            ownerId: actor.id,
            tokenHash: hashToken(token),
            encryptedToken: sealed.ciphertext,
            tokenNonce: sealed.nonce,
            tokenKeyId: sealed.keyId,
            includeChildren: limits.includeChildren,
            allowedCidrs: limits.allowedCidrs,
            allowedCountries: limits.allowedCountries,
            allowedContinents: limits.allowedContinents,
            maxViews: limits.maxViews ?? null,
            expiresAt: limits.expiresAt ?? null,
            passwordHash: limits.passwordHash ?? null
        },
        select: VIEW_SELECT
    });
    return { url: await noteShareUrl(token), share: toView(share) };
}

/** The link again, for an owner who closed the dialog. Needs the same
 *  permission publishing did: showing the URL is handing out the access. */
export async function revealNoteShare(actor: access.NoteActor, noteId: string): Promise<string> {
    await access.requireNote(actor, noteId, "member");
    const share = await prisma.noteShare.findUnique({
        where: { noteId },
        select: { encryptedToken: true, tokenNonce: true, tokenKeyId: true }
    });
    if (!share?.encryptedToken || !share.tokenNonce) {
        throw new access.NoteAccessError("That link can no longer be shown");
    }
    const token = decryptSecret(
        {
            ciphertext: Buffer.from(share.encryptedToken),
            nonce: Buffer.from(share.tokenNonce),
            keyId: share.tokenKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    return noteShareUrl(token);
}

/**
 * Unpublish.
 *
 * The row goes rather than being marked revoked: there is one link per note, so
 * a kept row would only be a token nobody can use taking up the unique index the
 * next link needs. What replaces it is a new token, which is the correct
 * behaviour anyway - a link that was taken down and put back is not the same
 * link.
 */
export async function unpublishNote(actor: access.NoteActor, noteId: string): Promise<void> {
    await access.requireNote(actor, noteId, "member");
    await prisma.noteShare.deleteMany({ where: { noteId } });
}

/** A published note, by its token, with everything the gate needs. Null for a
 *  token that names nothing - which is the same answer as one that was taken
 *  down, so the URL cannot be used to test which tokens exist. */
export async function resolveNoteShareByToken(token: string) {
    if (!token || token.length > 200) return null;
    return prisma.noteShare.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
            id: true,
            noteId: true,
            includeChildren: true,
            passwordHash: true,
            maxViews: true,
            viewCount: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true,
            expiresAt: true,
            revokedAt: true
        }
    });
}

export type NoteShareRecord = NonNullable<Awaited<ReturnType<typeof resolveNoteShareByToken>>>;

/** Whether the link is live at all. */
export function noteShareUsability(share: {
    revokedAt: Date | null;
    expiresAt: Date | null;
    maxViews: number | null;
    viewCount: number;
}): LinkUsability {
    return linkUsability({
        revokedAt: share.revokedAt,
        expiresAt: share.expiresAt,
        maxUses: share.maxViews,
        useCount: share.viewCount
    });
}

/**
 * Count one opening, and say whether it was allowed to happen.
 *
 * Conditional on the count, not on a read followed by a write: two people
 * opening the last permitted view at the same moment must not both get it, and
 * the only thing that can decide that is the database.
 */
export async function registerNoteShareView(shareId: string): Promise<boolean> {
    const capped = await prisma.noteShare.findUnique({
        where: { id: shareId },
        select: { maxViews: true }
    });
    if (!capped) return false;
    if (capped.maxViews === null) {
        await prisma.noteShare.update({ where: { id: shareId }, data: { viewCount: { increment: 1 } } });
        return true;
    }
    const taken = await prisma.noteShare.updateMany({
        where: { id: shareId, viewCount: { lt: capped.maxViews } },
        data: { viewCount: { increment: 1 } }
    });
    return taken.count > 0;
}

/** The password gate, in the same shape every other link's is. */
export function noteUnlockCookie(shareId: string): string {
    return unlockCookieName(NOTE_LINK_SCOPE, shareId);
}

export function signNoteUnlock(shareId: string, secret: string): string {
    return signUnlock(NOTE_LINK_SCOPE, shareId, secret);
}

export function verifyNoteUnlock(
    shareId: string,
    value: string | undefined,
    secret: string
): boolean {
    return verifyUnlock(NOTE_LINK_SCOPE, shareId, value, secret);
}

/** Whether a password opens this link. Wrong and unset both answer false: a link
 *  with no password never reaches here. */
export async function verifyNoteSharePassword(shareId: string, password: string): Promise<boolean> {
    const share = await prisma.noteShare.findUnique({
        where: { id: shareId },
        select: { passwordHash: true }
    });
    if (!share?.passwordHash) return false;
    return verifyLinkPassword(password, share.passwordHash);
}

/** What a visitor is shown: the note, and the pages under it when the link
 *  carries them. Nothing else - no ids, no shelf, no folder, no author. */
export interface PublishedNote {
    readonly title: string;
    readonly body: string;
    readonly children: readonly { readonly title: string; readonly body: string; }[];
    readonly updatedAt: string;
}

export async function readPublishedNote(share: {
    noteId: string;
    includeChildren: boolean;
}): Promise<PublishedNote | null> {
    const note = await prisma.note.findUnique({
        where: { id: share.noteId },
        select: { title: true, body: true, updatedAt: true, archived: true }
    });
    // An archived note is not published, whatever the link says: archiving is how
    // somebody takes a page out of circulation.
    if (!note || note.archived) return null;

    // One level down, not the whole subtree: a page whose pages have pages is a
    // wiki, and a public link is not the place to serve one whole.
    const children = share.includeChildren
        ? await prisma.note.findMany({
              where: { parentId: share.noteId, archived: false },
              orderBy: [{ pinned: "desc" }, { title: "asc" }],
              select: { title: true, body: true },
              take: 200
          })
        : [];

    return {
        title: note.title,
        body: note.body,
        children,
        updatedAt: note.updatedAt.toISOString()
    };
}
