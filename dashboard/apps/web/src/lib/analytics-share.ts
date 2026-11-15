/**
 * A site's numbers on a public address: `/sa/<token>` for anybody holding it,
 * `/sa/embed/<token>` for a page that frames it.
 *
 * Built on the same primitives every public link in Polaris uses
 * (`lib/link-guards`, `@polaris/core/link-password`, the sealed token), so a fix
 * to them reaches this too. The token is in the URL and nowhere else in the
 * clear; the row holds its hash and the token sealed under the master key, so
 * the owner can be shown the link again and a database dump yields no working
 * links.
 *
 * An embed never carries a password: a frame on another site is a third-party
 * context, where the unlock cookie is not sent, so a protected embed would be a
 * password form that never opens anything.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";
import { linkUsability, signUnlock, unlockCookieName, verifyUnlock, type LinkUsability } from "@/lib/link-guards";

/** The cookie namespace a solved analytics-link password is signed under. */
const SCOPE = "analytics";

/** How many links one site may have; a list, not a store. */
export const SHARE_LINKS_PER_SITE = 25;

/** The lifetimes offered, in days; null is "until removed". */
export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;

export const shareLinkInputSchema = z
    .object({
        label: z.string().trim().max(80).default(""),
        password: z.string().min(4).max(200).nullable().default(null),
        expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).nullable().default(null),
        range: core.visitRangeSchema.default("30d"),
        allowEmbed: z.boolean().default(false)
    })
    .refine((input) => !(input.allowEmbed && input.password), { path: ["allowEmbed"] });

export type ShareLinkInput = z.infer<typeof shareLinkInputSchema>;

/** A link as its owner sees it. */
export interface ShareLinkView {
    readonly id: string;
    readonly label: string;
    readonly url: string;
    readonly embedUrl: string | null;
    readonly hasPassword: boolean;
    readonly range: core.VisitRange;
    readonly expiresAt: string | null;
    readonly viewCount: number;
    readonly lastViewedAt: string | null;
    readonly createdAt: string;
    readonly usable: LinkUsability;
}

const VIEW_SELECT = {
    id: true,
    label: true,
    encryptedToken: true,
    tokenNonce: true,
    tokenKeyId: true,
    passwordHash: true,
    range: true,
    allowEmbed: true,
    expiresAt: true,
    viewCount: true,
    lastViewedAt: true,
    createdAt: true
} as const;

/** A stored range read back; anything unknown is the default. */
export function storedRange(value: string): core.VisitRange {
    const parsed = core.visitRangeSchema.safeParse(value);
    return parsed.success ? parsed.data : "30d";
}

function usabilityOf(row: { expiresAt: Date | null }): LinkUsability {
    return linkUsability({ revokedAt: null, expiresAt: row.expiresAt, maxUses: null, useCount: 0 });
}

/** The public addresses for a token, on the sharing hostname. */
export async function shareLinkUrls(token: string): Promise<{ url: string; embedUrl: string }> {
    // Loaded here rather than at the top: the domain module pulls in the edge
    // and tunnel services, which nothing else in Analytics' actions needs.
    const { sharingBaseUrl } = await import("@/lib/domain-service");
    const base = (await sharingBaseUrl()).replace(/\/+$/, "");
    return { url: `${base}/sa/${token}`, embedUrl: `${base}/sa/embed/${token}` };
}

function unseal(row: { encryptedToken: Uint8Array; tokenNonce: Uint8Array; tokenKeyId: string }): string {
    return decryptSecret(
        { ciphertext: Buffer.from(row.encryptedToken), nonce: Buffer.from(row.tokenNonce), keyId: row.tokenKeyId },
        loadEnv().POLARIS_MASTER_KEY
    );
}

async function toView(row: {
    id: string;
    label: string;
    encryptedToken: Uint8Array;
    tokenNonce: Uint8Array;
    tokenKeyId: string;
    passwordHash: string | null;
    range: string;
    allowEmbed: boolean;
    expiresAt: Date | null;
    viewCount: number;
    lastViewedAt: Date | null;
    createdAt: Date;
}): Promise<ShareLinkView> {
    const urls = await shareLinkUrls(unseal(row));
    return {
        id: row.id,
        label: row.label,
        url: urls.url,
        embedUrl: row.allowEmbed && !row.passwordHash ? urls.embedUrl : null,
        hasPassword: row.passwordHash !== null,
        range: storedRange(row.range),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        viewCount: row.viewCount,
        lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        usable: usabilityOf(row)
    };
}

/** A site's links, newest first. The caller has checked who is asking. */
export async function listShareLinks(siteId: string): Promise<ShareLinkView[]> {
    const rows = await prisma.analyticsShareLink.findMany({
        where: { siteId },
        orderBy: { createdAt: "desc" },
        take: SHARE_LINKS_PER_SITE,
        select: VIEW_SELECT
    });
    return Promise.all(rows.map(toView));
}

/** Make a link; null when the site already has as many as it may. */
export async function createShareLink(
    siteId: string,
    userId: string,
    input: ShareLinkInput,
    now: number = Date.now()
): Promise<ShareLinkView | null> {
    const count = await prisma.analyticsShareLink.count({ where: { siteId } });
    if (count >= SHARE_LINKS_PER_SITE) return null;
    const token = generateToken();
    const sealed = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    const row = await prisma.analyticsShareLink.create({
        data: {
            siteId,
            createdById: userId,
            label: input.label,
            tokenHash: hashToken(token),
            encryptedToken: sealed.ciphertext,
            tokenNonce: sealed.nonce,
            tokenKeyId: sealed.keyId ?? "",
            passwordHash: input.password ? await hashLinkPassword(input.password) : null,
            range: input.range,
            allowEmbed: input.allowEmbed && !input.password,
            expiresAt: input.expiresInDays ? new Date(now + input.expiresInDays * 86_400_000) : null
        },
        select: VIEW_SELECT
    });
    return toView(row);
}

/** Take a link down. Scoped to the site, so an id from another site does nothing. */
export async function deleteShareLink(siteId: string, id: string): Promise<boolean> {
    const removed = await prisma.analyticsShareLink.deleteMany({ where: { id, siteId } });
    return removed.count > 0;
}

/** A link by its token, with what the gate needs. Null for a token naming nothing. */
export async function resolveShareLink(token: string) {
    if (!token || token.length > 200) return null;
    return prisma.analyticsShareLink.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, siteId: true, passwordHash: true, range: true, allowEmbed: true, expiresAt: true }
    });
}

export type ShareLinkRecord = NonNullable<Awaited<ReturnType<typeof resolveShareLink>>>;

export function shareLinkUsability(link: { expiresAt: Date | null }): LinkUsability {
    return usabilityOf(link);
}

/** Count one opening. Best effort: a lost count never stops the page. */
export async function registerShareLinkView(id: string): Promise<void> {
    await prisma.analyticsShareLink
        .update({ where: { id }, data: { viewCount: { increment: 1 }, lastViewedAt: new Date() } })
        .catch(() => undefined);
}

export function shareUnlockCookie(id: string): string {
    return unlockCookieName(SCOPE, id);
}

export function signShareUnlock(id: string, passwordHash: string | null, secret: string): string {
    return signUnlock(SCOPE, id, { passwordHash }, secret);
}

export function verifyShareUnlock(
    id: string,
    value: string | undefined,
    passwordHash: string | null,
    secret: string
): boolean {
    return verifyUnlock(SCOPE, id, value, { passwordHash }, secret);
}

/** Whether a password opens this link; the comparison is constant-time
 *  (`verifyLinkPassword` compares the derived keys with `timingSafeEqual`). */
export async function verifySharePassword(link: { passwordHash: string | null }, password: string): Promise<boolean> {
    if (!link.passwordHash) return false;
    return verifyLinkPassword(password, link.passwordHash);
}
