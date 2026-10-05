/**
 * Office and Google Drive: bringing a Google Doc or Sheet in, and saving it back.
 *
 * Through somebody's own linked Google account, never a shared one - the same
 * two-layer arrangement the Calendar uses: the operator connects one Google
 * OAuth client in Integrations, and each person authorizes their own account
 * for Office (`drive.readonly` to list and export what they have, `drive.file`
 * to write the copies Polaris creates).
 *
 * **Importing** asks Google to export the file in the Office format Polaris
 * reads (a Doc as .docx, a Sheet as .xlsx) and opens that exactly as an upload
 * would be opened. Slides are listed but not imported: Office does not read
 * PowerPoint files yet, and an import that dropped every shape would be worse
 * than saying so.
 *
 * **Saving back** exports the Office document in the same format and uploads it
 * to Drive with conversion, so it arrives as a Google Doc or Sheet. The first
 * save creates a copy beside nothing in particular (Polaris may only write the
 * files it created) and every later save updates that same copy. The original
 * file is never written: that would need full access to somebody's Drive.
 *
 * **What this is not** is live co-editing with people working in Google Docs.
 * Google offers no way for a third-party editor to join a Docs session; the
 * closest is two-way sync through `documents.batchUpdate` and Drive change
 * notifications, which merges at the level of whole edits, not keystrokes. Here
 * the round trip is explicit: import, work in Polaris (live, with everybody in
 * Polaris), save back.
 *
 * Everything Google answers is parsed against a schema before it is used.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { exportDocument } from "./export";
import { importFile, OfficeImportError } from "./import";
import { applyUpdate, createDocument, deleteDocument, documentAccess, readDocument } from "./documents";
import { getConnection, listConnections, readCredential } from "@/lib/connections/store";
import {
    GOOGLE_DRIVE_FILE_SCOPE,
    GOOGLE_DRIVE_READ_SCOPE,
    getGoogleOAuthClient,
    googleAccessToken
} from "@/lib/google-calendar/service";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

/** The largest export Polaris reads back. Google itself stops exporting at ten
 *  megabytes, and an Office import is held in memory. */
export const MAX_GOOGLE_EXPORT_BYTES = 10 * 1024 * 1024;

/** The Google types Office deals in, what each is exported as, and what it
 *  becomes here. Slides have no Office importer yet, so `kind` is null. */
export const GOOGLE_OFFICE_TYPES = {
    "application/vnd.google-apps.document": {
        extension: "docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        kind: "doc"
    },
    "application/vnd.google-apps.spreadsheet": {
        extension: "xlsx",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        kind: "sheet"
    },
    "application/vnd.google-apps.presentation": {
        extension: "pptx",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        kind: null
    }
} as const satisfies Record<
    string,
    { extension: string; mime: string; kind: core.OfficeKind | null }
>;

export type GoogleOfficeMime = keyof typeof GOOGLE_OFFICE_TYPES;

export function isGoogleOfficeMime(mime: string): mime is GoogleOfficeMime {
    return Object.hasOwn(GOOGLE_OFFICE_TYPES, mime);
}

/** The Google type an Office kind is saved back as, or null for a kind that is
 *  not saved to Google. */
export function googleMimeFor(kind: core.OfficeKind): GoogleOfficeMime | null {
    if (kind === "doc") return "application/vnd.google-apps.document";
    if (kind === "sheet") return "application/vnd.google-apps.spreadsheet";
    return null;
}

/** A refusal somebody can act on, in a sentence. */
export class OfficeGoogleError extends Error {
    public constructor(
        public readonly reason:
            | "no-client"
            | "no-account"
            | "relink"
            | "not-supported"
            | "too-large"
            | "not-found"
            | "denied"
            | "api-off"
            | "busy"
            | "failed"
    ) {
        super(reason);
        this.name = "OfficeGoogleError";
    }
}

/** Whether a granted scope string holds this scope. */
function holds(scope: string, wanted: string): boolean {
    return scope.split(/\s+/).includes(wanted);
}

/** One Google account this person linked, as Office sees it. */
export interface OfficeGoogleAccount {
    readonly id: string;
    readonly label: string;
    /** Whether it was authorized to read Drive - linked for Office. */
    readonly canImport: boolean;
    /** Whether it may write the copies a save creates. */
    readonly canSave: boolean;
}

/** Whether this Polaris has a Google client at all, and the accounts this
 *  person linked through it. */
export async function officeGoogleState(userId: string): Promise<{
    readonly available: boolean;
    readonly accounts: OfficeGoogleAccount[];
}> {
    const client = await getGoogleOAuthClient();
    if (!client) return { available: false, accounts: [] };
    const links = (await listConnections(userId, "google")).filter((link) => link.method === "oauth");
    return {
        available: true,
        accounts: links.map((link) => ({
            id: link.id,
            label: link.label,
            canImport: holds(link.scope, GOOGLE_DRIVE_READ_SCOPE),
            canSave: holds(link.scope, GOOGLE_DRIVE_FILE_SCOPE)
        }))
    };
}

/** An access token for one of this person's own linked accounts. Never another
 *  person's: the id is looked up under theirs. */
async function tokenFor(userId: string, connectionId: string, need: string): Promise<string> {
    const client = await getGoogleOAuthClient();
    if (!client) throw new OfficeGoogleError("no-client");
    const link = await getConnection(userId, connectionId);
    if (!link || link.provider !== "google" || link.method !== "oauth") {
        throw new OfficeGoogleError("no-account");
    }
    if (!holds(link.scope, need)) throw new OfficeGoogleError("relink");
    const refreshToken = (await readCredential(link.id))?.refreshToken;
    if (!refreshToken) throw new OfficeGoogleError("relink");
    try {
        return await googleAccessToken(client, refreshToken);
    } catch {
        throw new OfficeGoogleError("relink");
    }
}

/** Google's answer, refused as a sentence somebody can act on. */
async function driveFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(30_000)
    });
    if (response.ok) return response;
    if (response.status === 404) throw new OfficeGoogleError("not-found");
    // Read the way every other Google call here is read, so the Drive API being
    // off in the operator's project is said as that - not as a file somebody
    // was not allowed to open.
    const problem = core.readGoogleApiError(
        response.status,
        await response.json().catch(() => undefined)
    );
    if (problem.kind === "setup") throw new OfficeGoogleError("api-off");
    if (problem.kind === "auth" || problem.kind === "consent") throw new OfficeGoogleError("relink");
    if (problem.kind === "rate") throw new OfficeGoogleError("busy");
    if (response.status === 403) throw new OfficeGoogleError("denied");
    throw new OfficeGoogleError("failed");
}

const fileSchema = z.object({
    id: z.string().min(1).max(200),
    name: z.string().max(500),
    mimeType: z.string().max(200),
    modifiedTime: z.string().max(64).optional(),
    webViewLink: z.string().url().optional()
});

const fileListSchema = z.object({
    files: z.array(fileSchema).default([]),
    nextPageToken: z.string().max(2000).optional()
});

/** One file, as the import list shows it. */
export interface GoogleOfficeFile {
    readonly id: string;
    readonly name: string;
    readonly mime: GoogleOfficeMime;
    readonly modifiedAt: string | null;
    /** Whether Office can open it. */
    readonly importable: boolean;
    readonly link: string | null;
}

/** Drive's query language needs quotes and backslashes escaped in a literal. */
export function driveQueryLiteral(text: string): string {
    return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The Drive query for Office's files, optionally narrowed by name. */
export function driveOfficeQuery(search: string): string {
    const types = Object.keys(GOOGLE_OFFICE_TYPES)
        .map((mime) => `mimeType = ${driveQueryLiteral(mime)}`)
        .join(" or ");
    const named = search.trim() ? ` and name contains ${driveQueryLiteral(search.trim().slice(0, 100))}` : "";
    return `(${types}) and trashed = false${named}`;
}

/** The Docs, Sheets and Slides in one account, newest first, a page at a time. */
export async function listGoogleOfficeFiles(
    userId: string,
    connectionId: string,
    search: string,
    pageToken: string | null
): Promise<{ files: GoogleOfficeFile[]; next: string | null }> {
    const token = await tokenFor(userId, connectionId, GOOGLE_DRIVE_READ_SCOPE);
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set("q", driveOfficeQuery(search));
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("pageSize", "50");
    url.searchParams.set("fields", "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink)");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const parsed = fileListSchema.safeParse(await (await driveFetch(token, url.toString())).json());
    if (!parsed.success) throw new OfficeGoogleError("failed");
    return {
        files: parsed.data.files.flatMap((file) =>
            isGoogleOfficeMime(file.mimeType)
                ? [
                      {
                          id: file.id,
                          name: file.name,
                          mime: file.mimeType,
                          modifiedAt: file.modifiedTime ?? null,
                          importable: GOOGLE_OFFICE_TYPES[file.mimeType].kind !== null,
                          link: file.webViewLink ?? null
                      }
                  ]
                : []
        ),
        next: parsed.data.nextPageToken ?? null
    };
}

/** Read a response body up to a limit, refusing past it rather than holding it. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) throw new OfficeGoogleError("too-large");
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array(await response.arrayBuffer());
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel().catch(() => undefined);
            throw new OfficeGoogleError("too-large");
        }
        parts.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }
    return out;
}

/**
 * Bring one Google Doc or Sheet in as a new Office document.
 *
 * The file's type is read from Google, never taken from the browser, and the
 * shelf it lands on is `createDocument`'s to allow.
 */
export async function importGoogleFile(
    user: { id: string },
    connectionId: string,
    fileId: string,
    orgId: string | null
): Promise<{ id: string; kind: core.OfficeKind; title: string }> {
    const token = await tokenFor(user.id, connectionId, GOOGLE_DRIVE_READ_SCOPE);
    const metaUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
    metaUrl.searchParams.set("fields", "id, name, mimeType");
    metaUrl.searchParams.set("supportsAllDrives", "true");
    const meta = fileSchema.safeParse(await (await driveFetch(token, metaUrl.toString())).json());
    if (!meta.success) throw new OfficeGoogleError("failed");
    if (!isGoogleOfficeMime(meta.data.mimeType)) throw new OfficeGoogleError("not-supported");
    const target = GOOGLE_OFFICE_TYPES[meta.data.mimeType];
    if (target.kind === null) throw new OfficeGoogleError("not-supported");

    const exportUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(meta.data.id)}/export`);
    exportUrl.searchParams.set("mimeType", target.mime);
    const bytes = await readCapped(await driveFetch(token, exportUrl.toString()), MAX_GOOGLE_EXPORT_BYTES);

    const name = (meta.data.name.trim() || "Untitled").replace(/[\\/]/g, "-");
    let imported;
    try {
        imported = await importFile(`${name}.${target.extension}`, bytes);
    } catch (caught) {
        if (caught instanceof OfficeImportError) throw caught;
        throw new OfficeGoogleError("failed");
    }
    const documentId = await createDocument(user, { kind: imported.kind, title: imported.title, orgId });
    try {
        await applyUpdate(user, documentId, imported.update);
        await prisma.officeGoogleFile.create({
            data: {
                documentId,
                connectionId,
                sourceFileId: meta.data.id,
                sourceMime: meta.data.mimeType,
                sourceName: meta.data.name.slice(0, 500)
            }
        });
    } catch (caught) {
        await deleteDocument(user, documentId).catch(() => undefined);
        throw caught;
    }
    return { id: documentId, kind: imported.kind, title: imported.title };
}

/** What the document chrome says about a document's Google side. */
export interface OfficeGoogleLink {
    readonly sourceName: string;
    /** Whether this reader can save it back - their account brought it in. */
    readonly mine: boolean;
    readonly savedAt: string | null;
    readonly copyLink: string | null;
}

export async function googleLinkOf(userId: string, documentId: string): Promise<OfficeGoogleLink | null> {
    if (!(await documentAccess({ id: userId }, documentId))) return null;
    const row = await prisma.officeGoogleFile.findUnique({
        where: { documentId },
        select: { connectionId: true, sourceName: true, savedAt: true, copyFileId: true, sourceMime: true }
    });
    if (!row) return null;
    const link = await getConnection(userId, row.connectionId);
    return {
        sourceName: row.sourceName,
        mine: Boolean(link),
        savedAt: row.savedAt?.toISOString() ?? null,
        copyLink: row.copyFileId ? editLinkFor(row.sourceMime, row.copyFileId) : null
    };
}

/** Where a Google file opens for editing. */
export function editLinkFor(mime: string, fileId: string): string {
    const id = encodeURIComponent(fileId);
    if (mime === "application/vnd.google-apps.spreadsheet") return `https://docs.google.com/spreadsheets/d/${id}/edit`;
    if (mime === "application/vnd.google-apps.presentation") return `https://docs.google.com/presentation/d/${id}/edit`;
    return `https://docs.google.com/document/d/${id}/edit`;
}

/** A multipart body: the file's metadata as JSON, then its bytes. */
export function multipartBody(
    metadata: Record<string, unknown>,
    mime: string,
    bytes: Uint8Array,
    boundary: string
): Uint8Array {
    const encoder = new TextEncoder();
    const json = JSON.stringify(metadata);
    const head = encoder.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
    );
    const tail = encoder.encode(`\r\n--${boundary}--`);
    const out = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);
    out.set(head, 0);
    out.set(bytes, head.byteLength);
    out.set(tail, head.byteLength + bytes.byteLength);
    return out;
}

const createdSchema = z.object({ id: z.string().min(1).max(200) });

/**
 * Save a document that came from Google back to Google.
 *
 * Only by the person whose account brought it in, and only by somebody who may
 * read it here. The first save creates a Google copy; every later one updates
 * that copy. Answers with where it can be opened.
 */
export async function saveToGoogle(user: { id: string }, documentId: string): Promise<{ link: string }> {
    const row = await prisma.officeGoogleFile.findUnique({ where: { documentId } });
    if (!row) throw new OfficeGoogleError("not-found");
    const found = await readDocument(user, documentId);
    if (!found) throw new OfficeGoogleError("not-found");
    const googleMime = googleMimeFor(found.view.kind);
    if (!googleMime) throw new OfficeGoogleError("not-supported");
    const format = GOOGLE_OFFICE_TYPES[googleMime];

    const token = await tokenFor(user.id, row.connectionId, GOOGLE_DRIVE_FILE_SCOPE);
    const file = await exportDocument(found.view.kind, found.view.title, found.content, format.extension);
    if (!file) throw new OfficeGoogleError("not-supported");

    let copyId = row.copyFileId;
    if (copyId) {
        // The same copy, its contents replaced and converted again.
        const url = new URL(`${DRIVE_UPLOAD}/files/${encodeURIComponent(copyId)}`);
        url.searchParams.set("uploadType", "media");
        url.searchParams.set("supportsAllDrives", "true");
        try {
            await driveFetch(token, url.toString(), {
                method: "PATCH",
                headers: { "content-type": format.mime },
                body: file.bytes as unknown as BodyInit
            });
        } catch (caught) {
            // Deleted on the Google side since: make a new copy rather than fail.
            if (!(caught instanceof OfficeGoogleError && caught.reason === "not-found")) throw caught;
            copyId = null;
        }
    }
    if (!copyId) {
        const boundary = `polaris${crypto.randomUUID().replace(/-/g, "")}`;
        const url = new URL(`${DRIVE_UPLOAD}/files`);
        url.searchParams.set("uploadType", "multipart");
        url.searchParams.set("fields", "id");
        const created = createdSchema.safeParse(
            await (
                await driveFetch(token, url.toString(), {
                    method: "POST",
                    headers: { "content-type": `multipart/related; boundary=${boundary}` },
                    body: multipartBody(
                        { name: found.view.title, mimeType: googleMime },
                        format.mime,
                        file.bytes,
                        boundary
                    ) as unknown as BodyInit
                })
            ).json()
        );
        if (!created.success) throw new OfficeGoogleError("failed");
        copyId = created.data.id;
    }
    await prisma.officeGoogleFile.update({
        where: { documentId },
        data: { copyFileId: copyId, savedAt: new Date() }
    });
    return { link: editLinkFor(googleMime, copyId) };
}
