/**
 * The facts a link preview is drawn from, read for one public address.
 *
 * Read-only by construction: every read is a `findUnique` over metadata columns,
 * never a link gate (the gates log refused attempts) and never the page's own
 * loader (those count views, spend downloads and burn one-time links). A crawler
 * fetching a preview must leave no trace on the link it is previewing.
 *
 * Whatever the row says, `mayDisclose` decides; anything that throws - a bad
 * token, an unreachable database - answers the generic preview for the kind.
 */

import { prisma } from "@polaris/db";
import { hashToken } from "@polaris/core/tokens";
import { baseName, formatBytes } from "@polaris/core";
import { orgProfile, publicProfile } from "@/lib/profile-service";
import {
    mayDisclose,
    previewText,
    type LinkPreview,
    type PreviewKind,
    type PreviewLinkState
} from "./policy";

/** A token or handle long or odd enough that no link could have it. */
function implausible(token: string): boolean {
    return !token || token.length > 256 || /[\s/\\]/.test(token);
}

const GUARD_COLUMNS = {
    passwordHash: true,
    allowedCidrs: true,
    allowedCountries: true,
    allowedContinents: true,
    startsAt: true,
    allowedUsers: true,
    linkSchedule: true
} as const;

/** A found row's facts: its guard state, and the name and detail it would show. */
interface Found {
    state: PreviewLinkState;
    title?: string | null;
    detail?: string | null;
    /** How many files a multi-file transfer holds. */
    fileCount?: number;
}

/** What each kind reads. Kinds absent here never name anything. */
const READERS: Partial<Record<PreviewKind, (token: string) => Promise<Found | null>>> = {
    async share(token) {
        const row = await prisma.share.findUnique({
            where: { tokenHash: hashToken(token) },
            select: {
                ...GUARD_COLUMNS,
                path: true,
                kind: true,
                requireLogin: true,
                maxDownloads: true,
                downloadCount: true,
                expiresAt: true,
                revokedAt: true
            }
        });
        if (!row) return null;
        return {
            state: {
                ...row,
                disabled: row.kind !== "public",
                limits: {
                    revokedAt: row.revokedAt,
                    expiresAt: row.expiresAt,
                    startsAt: row.startsAt,
                    maxUses: row.maxDownloads,
                    useCount: row.downloadCount
                }
            },
            title: baseName(row.path)
        };
    },

    async transfer(token) {
        const row = await prisma.disposableTransfer.findUnique({
            where: { token },
            select: {
                expiresAt: true,
                maxDownloads: true,
                readyAt: true,
                totalSize: true,
                files: {
                    select: { name: true, size: true, maxDownloads: true, downloadCount: true },
                    take: 50
                }
            }
        });
        if (!row) return null;
        const files = row.files;
        // The most-downloaded file decides: a link with one file used up is
        // already partly gone, and saying less is the safe side.
        const used = files.reduce((top, file) => Math.max(top, file.downloadCount), 0);
        const single = files.length === 1 ? files[0] : undefined;
        return {
            state: {
                disabled: !row.readyAt || files.length === 0,
                oneTime: files.some((file) => file.maxDownloads !== null && file.maxDownloads <= 1),
                limits: {
                    revokedAt: null,
                    expiresAt: row.expiresAt,
                    maxUses: row.maxDownloads,
                    useCount: used
                }
            },
            title: single ? single.name : null,
            detail: formatBytes(single ? single.size : row.totalSize),
            ...(single ? {} : { fileCount: files.length })
        };
    },

    async snippet(token) {
        const row = await prisma.snippet.findUnique({
            where: { tokenHash: hashToken(token) },
            select: {
                ...GUARD_COLUMNS,
                title: true,
                visibility: true,
                requireLogin: true,
                maxViews: true,
                viewCount: true,
                expiresAt: true,
                revokedAt: true,
                burnAfterRead: true,
                clientSealed: true
            }
        });
        if (!row) return null;
        return {
            state: {
                ...row,
                disabled: row.visibility === "private" || row.visibility === "invite",
                oneTime: row.burnAfterRead,
                sealed: row.clientSealed,
                limits: {
                    revokedAt: row.revokedAt,
                    expiresAt: row.expiresAt,
                    startsAt: row.startsAt,
                    maxUses: row.maxViews,
                    useCount: row.viewCount
                }
            },
            title: row.title
        };
    },

    async fileRequest(token) {
        const row = await prisma.fileRequest.findUnique({
            where: { tokenHash: hashToken(token) },
            select: { ...GUARD_COLUMNS, title: true, requireLogin: true, expiresAt: true, revokedAt: true }
        });
        if (!row) return null;
        return {
            state: { ...row, limits: { ...limitsOf(row), maxUses: null, useCount: 0 } },
            title: row.title
        };
    },

    async textRequest(token) {
        const row = await prisma.textRequest.findUnique({
            where: { tokenHash: hashToken(token) },
            select: { ...GUARD_COLUMNS, title: true, requireLogin: true, expiresAt: true, revokedAt: true }
        });
        if (!row) return null;
        return {
            state: { ...row, limits: { ...limitsOf(row), maxUses: null, useCount: 0 } },
            title: row.title
        };
    },

    async note(token) {
        const row = await prisma.noteShare.findUnique({
            where: { tokenHash: hashToken(token) },
            select: {
                ...GUARD_COLUMNS,
                noteId: true,
                requireLogin: true,
                maxViews: true,
                viewCount: true,
                expiresAt: true,
                revokedAt: true
            }
        });
        if (!row) return null;
        const note = await prisma.note.findUnique({
            where: { id: row.noteId },
            select: { title: true, archived: true }
        });
        return {
            state: {
                ...row,
                disabled: !note || note.archived,
                limits: { ...limitsOf(row), maxUses: row.maxViews, useCount: row.viewCount }
            },
            title: note?.title
        };
    },

    async task(token) {
        const row = await prisma.taskShare.findUnique({
            where: { token },
            select: {
                ...GUARD_COLUMNS,
                requireLogin: true,
                maxViews: true,
                views: true,
                expiresAt: true,
                task: { select: { name: true, archived: true } }
            }
        });
        if (!row) return null;
        return {
            state: {
                ...row,
                disabled: !row.task || row.task.archived,
                limits: {
                    revokedAt: null,
                    expiresAt: row.expiresAt,
                    startsAt: row.startsAt,
                    maxUses: row.maxViews,
                    useCount: row.views
                }
            },
            title: row.task?.name
        };
    },

    async document(token) {
        const row = await prisma.officeLink.findUnique({
            where: { tokenHash: hashToken(token) },
            select: {
                ...GUARD_COLUMNS,
                requireLogin: true,
                maxUses: true,
                useCount: true,
                expiresAt: true,
                revokedAt: true,
                document: { select: { title: true, archived: true, trashedAt: true } }
            }
        });
        if (!row) return null;
        const doc = row.document;
        return {
            state: {
                ...row,
                disabled: !doc || doc.archived || doc.trashedAt !== null,
                limits: { ...limitsOf(row), maxUses: row.maxUses, useCount: row.useCount }
            },
            title: doc?.title
        };
    },

    async form(token) {
        const row = await prisma.taskForm.findUnique({
            where: { token },
            select: { ...GUARD_COLUMNS, name: true, enabled: true, requireLogin: true, expiresAt: true }
        });
        if (!row) return null;
        return {
            state: {
                ...row,
                disabled: !row.enabled,
                limits: {
                    revokedAt: null,
                    expiresAt: row.expiresAt,
                    startsAt: row.startsAt,
                    maxUses: null,
                    useCount: 0
                }
            },
            title: row.name
        };
    },

    async meeting(token) {
        const row = await prisma.meeting.findUnique({
            where: { guestToken: token },
            select: {
                allowedCidrs: true,
                allowedCountries: true,
                allowedContinents: true,
                startsAt: true,
                allowedUsers: true,
                linkSchedule: true,
                title: true,
                requireAccount: true,
                joinCode: true,
                linkPasswordHash: true,
                endedAt: true
            }
        });
        if (!row) return null;
        return {
            state: {
                ...row,
                passwordHash: row.linkPasswordHash ?? row.joinCode,
                requireLogin: row.requireAccount,
                disabled: row.endedAt !== null,
                limits: {
                    revokedAt: null,
                    expiresAt: null,
                    startsAt: row.startsAt,
                    maxUses: null,
                    useCount: 0
                }
            },
            title: row.title
        };
    },

    async chat(token) {
        const row = await prisma.polarThreadShare.findUnique({
            where: { tokenHash: hashToken(token) },
            select: {
                ...GUARD_COLUMNS,
                requireLogin: true,
                linkEnabled: true,
                maxViews: true,
                views: true,
                expiresAt: true,
                thread: { select: { title: true, archivedAt: true } }
            }
        });
        if (!row) return null;
        return {
            state: {
                ...row,
                disabled: !row.linkEnabled || !row.thread || row.thread.archivedAt !== null,
                limits: {
                    revokedAt: null,
                    expiresAt: row.expiresAt,
                    startsAt: row.startsAt,
                    maxUses: row.maxViews,
                    useCount: row.views
                }
            },
            title: row.thread?.title
        };
    }
};

function limitsOf(row: { expiresAt: Date | null; revokedAt: Date | null; startsAt: Date | null }) {
    return { revokedAt: row.revokedAt, expiresAt: row.expiresAt, startsAt: row.startsAt };
}

/** The details a disclosed row hands the preview, cleaned for drawing. */
export interface ResolvedPreview extends LinkPreview {
    /** How many files a multi-file transfer holds, for the "{count} files" title. */
    fileCount?: number;
}

/**
 * What the preview for `kind` + `token` may show. Never throws, never writes.
 * A profile or organization is shown only as a signed-out reader would see it,
 * which is nothing at all unless the operator publishes profiles.
 */
export async function resolveLinkPreview(kind: PreviewKind, token: string): Promise<ResolvedPreview> {
    const generic: ResolvedPreview = { kind };
    if (implausible(token)) return generic;
    try {
        if (kind === "profile") {
            const profile = await publicProfile(token, null);
            const title = previewText(profile?.name);
            return profile && title ? { kind, title, detail: `@${profile.username}` } : generic;
        }
        if (kind === "org") {
            const org = await orgProfile(token, null);
            const title = previewText(org?.name);
            return org && title ? { kind, title, detail: `@${org.slug}` } : generic;
        }
        const read = READERS[kind];
        const found = read ? await read(token) : null;
        if (!found || !mayDisclose(kind, found.state)) return generic;
        return {
            kind,
            title: previewText(found.title),
            detail: previewText(found.detail, 60),
            ...(found.fileCount ? { fileCount: found.fileCount } : {})
        };
    } catch (caught) {
        console.error("Link preview could not be read", kind, caught);
        return generic;
    }
}
