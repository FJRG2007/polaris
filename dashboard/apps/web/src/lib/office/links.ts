/**
 * Opening a document with a link instead of an account.
 *
 * The other half of sharing. `AccessGrant` hands a document to a person, a team
 * or an organization's role, and every one of those is an account on this
 * Polaris. This is for everybody else - a client, a supplier, somebody on a
 * phone who is not going to sign in for one document.
 *
 * Everything about how a link is guarded is `lib/link-guards.ts`, shared with
 * Drive shares, drop points and snippets: the same password check, the same
 * expiry and use ceiling, the same signed unlock cookie. A second copy of any of
 * that would be a second place for a link to be readable after it was revoked.
 *
 * Two rules a link never bends, and they are why a link can carry `editor`
 * without being frightening:
 *
 * - **A link can never share the document on.** Sharing takes ownership, and a
 *   link is not an owner. Whoever holds one cannot make another.
 * - **A link can never delete it.** Editing every word and removing the thing
 *   are different powers, and only one of them is on the other side of a URL
 *   somebody might forward.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { sharingBaseUrl } from "@/lib/domain-service";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";
import { linkUsability, signUnlock, unlockCookieName, verifyUnlock } from "@/lib/link-guards";

/** The unlock-cookie namespace office links are signed under. Its own, so a
 *  cookie solved for a Drive share is not a cookie that opens a document. */
export const OFFICE_LINK_SCOPE = "officedoc";

/** Where a link lands. */
export function officeLinkPath(token: string): string {
    return `/od/${token}`;
}

/** One link, as the screen that made it draws it. Never the token: that is
 *  revealed on its own, by a call that says so. */
export interface OfficeLinkView {
    readonly id: string;
    readonly role: core.OfficeRole;
    readonly hasPassword: boolean;
    readonly expiresAt: string | null;
    readonly revokedAt: string | null;
    readonly maxUses: number | null;
    readonly useCount: number;
    readonly lastUsedAt: string | null;
    readonly note: string;
    readonly createdAt: string;
    /** Why it cannot be used, when it cannot. Said on the row rather than worked
     *  out on the screen, so the reason is the same one the visitor meets. */
    readonly standing: "live" | "revoked" | "expired" | "exhausted" | "scheduled";
}

const LINK_FIELDS = {
    id: true,
    role: true,
    passwordHash: true,
    expiresAt: true,
    revokedAt: true,
    maxUses: true,
    useCount: true,
    lastUsedAt: true,
    note: true,
    createdAt: true
} as const;

type LinkRow = {
    id: string;
    role: string;
    passwordHash: string | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    maxUses: number | null;
    useCount: number;
    lastUsedAt: Date | null;
    note: string;
    createdAt: Date;
};

function viewOf(row: LinkRow): OfficeLinkView {
    const usable = linkUsability({
        revokedAt: row.revokedAt,
        startsAt: null,
        expiresAt: row.expiresAt,
        maxUses: row.maxUses,
        useCount: row.useCount
    });
    return {
        id: row.id,
        role: core.isOfficeRole(row.role) ? row.role : "viewer",
        hasPassword: Boolean(row.passwordHash),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        maxUses: row.maxUses,
        useCount: row.useCount,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
        standing: usable.ok ? "live" : (usable.reason as OfficeLinkView["standing"])
    };
}

/** Every link one document hands out. */
export async function listLinks(documentId: string): Promise<OfficeLinkView[]> {
    const rows = await prisma.officeLink.findMany({
        where: { documentId },
        orderBy: { createdAt: "desc" },
        select: LINK_FIELDS
    });
    return rows.map(viewOf);
}

export interface NewLink {
    readonly role: core.OfficeRole;
    readonly password: string;
    /** ISO, or "" for one that does not expire. */
    readonly expiresAt: string;
    readonly maxUses: number | null;
    readonly note: string;
}

/**
 * Make one, and hand back the address exactly once.
 *
 * The token is generated here and never stored in the clear beyond the envelope
 * beside it - the row holds its hash, so a database dump yields no working
 * links. The URL is built on the address Polaris hands out rather than on
 * whatever hostname the person making it happens to be using, because a link is
 * for somebody else.
 */
export async function createLink(
    documentId: string,
    createdById: string,
    input: NewLink
): Promise<{ url: string; view: OfficeLinkView }> {
    const token = generateToken();
    const sealed = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    const row = await prisma.officeLink.create({
        data: {
            documentId,
            createdById,
            role: input.role,
            tokenHash: hashToken(token),
            encryptedToken: sealed.ciphertext,
            tokenNonce: sealed.nonce,
            tokenKeyId: sealed.keyId,
            passwordHash: input.password ? await hashLinkPassword(input.password) : null,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            maxUses: input.maxUses,
            note: input.note
        },
        select: LINK_FIELDS
    });
    return { url: `${await sharingBaseUrl()}${officeLinkPath(token)}`, view: viewOf(row) };
}

/** The address of a link that already exists, for somebody who closed the dialog
 *  before copying it. A link that cannot be re-read is one people replace. */
export async function revealLink(documentId: string, linkId: string): Promise<string | null> {
    const row = await prisma.officeLink.findFirst({
        where: { id: linkId, documentId },
        select: { encryptedToken: true, tokenNonce: true, tokenKeyId: true }
    });
    if (!row?.encryptedToken || !row.tokenNonce || !row.tokenKeyId) return null;
    try {
        const token = decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedToken),
                nonce: Buffer.from(row.tokenNonce),
                keyId: row.tokenKeyId
            },
            loadEnv().POLARIS_MASTER_KEY
        );
        return `${await sharingBaseUrl()}${officeLinkPath(token)}`;
    } catch {
        // The master key has changed under it. The link still works for whoever
        // has it; it simply cannot be shown again.
        return null;
    }
}

/** Stop one. Never deleted: a revoked link that is still listed is how somebody
 *  answers "did we ever send this out". */
export async function revokeLink(documentId: string, linkId: string): Promise<void> {
    await prisma.officeLink.updateMany({
        where: { id: linkId, documentId, revokedAt: null },
        data: { revokedAt: new Date() }
    });
}

/** What a visitor arriving with a token gets. */
export interface LinkVisit {
    readonly linkId: string;
    readonly documentId: string;
    readonly role: core.OfficeRole;
    readonly needsPassword: boolean;
    /** Why it will not open, when it will not. */
    readonly refusal: "" | "unknown" | "revoked" | "expired" | "exhausted" | "scheduled";
}

/**
 * Resolve a token, without counting a use.
 *
 * Looking is not using. The count is what a "three openings" link is measured
 * by, and spending one to draw the password form would mean a link with a
 * password is worth a third of what it says.
 */
export async function resolveLink(token: string): Promise<LinkVisit | null> {
    const row = await prisma.officeLink.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { ...LINK_FIELDS, documentId: true }
    });
    if (!row) return null;
    const usable = linkUsability({
        revokedAt: row.revokedAt,
        startsAt: null,
        expiresAt: row.expiresAt,
        maxUses: row.maxUses,
        useCount: row.useCount
    });
    return {
        linkId: row.id,
        documentId: row.documentId,
        role: core.isOfficeRole(row.role) ? row.role : "viewer",
        needsPassword: Boolean(row.passwordHash),
        refusal: usable.ok ? "" : (usable.reason as LinkVisit["refusal"])
    };
}

/** Whether the password somebody typed is the one on the link. */
export async function linkPasswordMatches(linkId: string, password: string): Promise<boolean> {
    const row = await prisma.officeLink.findUnique({
        where: { id: linkId },
        select: { passwordHash: true }
    });
    if (!row?.passwordHash) return true;
    return verifyLinkPassword(password, row.passwordHash);
}

/**
 * Count one opening, bounded in the statement.
 *
 * Two people arriving together on the last use of a link cannot both be let in:
 * the update matches only while there is a use left, and the one that changes
 * nothing is the one refused.
 */
export async function spendLink(linkId: string): Promise<boolean> {
    const row = await prisma.officeLink.findUnique({
        where: { id: linkId },
        select: { maxUses: true }
    });
    if (!row) return false;
    if (row.maxUses === null) {
        await prisma.officeLink.update({ where: { id: linkId }, data: { lastUsedAt: new Date() } });
        return true;
    }
    const spent = await prisma.officeLink.updateMany({
        where: { id: linkId, useCount: { lt: row.maxUses } },
        data: { useCount: { increment: 1 }, lastUsedAt: new Date() }
    });
    return spent.count > 0;
}

/** The cookie that says this browser has solved this link's password. */
export function linkUnlockCookie(linkId: string): string {
    return unlockCookieName(OFFICE_LINK_SCOPE, linkId);
}

export function signLinkUnlock(linkId: string): string {
    return signUnlock(OFFICE_LINK_SCOPE, linkId, loadEnv().POLARIS_AUTH_SECRET);
}

export function linkUnlocked(linkId: string, value: string | undefined): boolean {
    return verifyUnlock(OFFICE_LINK_SCOPE, linkId, value, loadEnv().POLARIS_AUTH_SECRET);
}

/**
 * The cookie a browser carries to say which document a link let it into, and at
 * what.
 *
 * Signed like the unlock above, and named per document rather than per link:
 * what the API routes have to answer is "may this browser write to this
 * document", and a link id would make them look one up on every keystroke.
 */
export function linkPassCookie(documentId: string): string {
    return unlockCookieName(`${OFFICE_LINK_SCOPE}pass`, documentId);
}

export function signLinkPass(documentId: string, role: core.OfficeRole): string {
    return `${role}.${signUnlock(`${OFFICE_LINK_SCOPE}pass:${role}`, documentId, loadEnv().POLARIS_AUTH_SECRET)}`;
}

/**
 * What a browser's pass says it may do here, or null.
 *
 * The role is inside the signature rather than beside it, so a visitor cannot
 * promote a viewer's cookie to an editor's by editing the half in front of the
 * dot.
 */
export function readLinkPass(documentId: string, value: string | undefined): core.OfficeRole | null {
    if (!value) return null;
    const at = value.indexOf(".");
    if (at < 0) return null;
    const role = value.slice(0, at);
    if (!core.isOfficeRole(role)) return null;
    const signed = verifyUnlock(
        `${OFFICE_LINK_SCOPE}pass:${role}`,
        documentId,
        value.slice(at + 1),
        loadEnv().POLARIS_AUTH_SECRET
    );
    return signed ? role : null;
}
