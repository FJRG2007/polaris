/**
 * Office and Google Drive.
 *
 * Pinned here: that only the caller's own linked account is ever used, and only
 * with the grant the step needs; that a file's type is Google's answer rather
 * than the browser's, so Slides are refused rather than half-imported; that an
 * export past the limit is refused while it is read rather than after; and that
 * saving back creates one Google copy and updates that same copy afterwards -
 * making a new one only when the old one is gone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const READ = "https://www.googleapis.com/auth/drive.readonly";
const WRITE = "https://www.googleapis.com/auth/drive.file";

const getConnection = vi.fn();
const listConnections = vi.fn();
const readCredential = vi.fn();
const getGoogleOAuthClient = vi.fn();
const googleAccessToken = vi.fn();
const importFile = vi.fn();
const createDocument = vi.fn();
const applyUpdate = vi.fn();
const readDocument = vi.fn();
const deleteDocument = vi.fn();
const documentAccess = vi.fn();
const exportDocument = vi.fn();
const officeGoogleFile = {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn()
};

class OfficeImportError extends Error {}

vi.mock("@polaris/db", () => ({ prisma: { officeGoogleFile } }));
vi.mock("@/lib/connections/store", () => ({ getConnection, listConnections, readCredential }));
vi.mock("@/lib/google-calendar/service", () => ({
    GOOGLE_DRIVE_READ_SCOPE: READ,
    GOOGLE_DRIVE_FILE_SCOPE: WRITE,
    getGoogleOAuthClient,
    googleAccessToken
}));
vi.mock("@/lib/office/import", () => ({ importFile, OfficeImportError }));
vi.mock("@/lib/office/documents", () => ({ applyUpdate, createDocument, deleteDocument, documentAccess, readDocument }));
vi.mock("@/lib/office/export", () => ({ exportDocument }));

const google = await import("../../src/lib/office/google");

const CONNECTION = "0190a6a4-0000-7000-8000-000000000001";
const DOC_MIME = "application/vnd.google-apps.document";
const SLIDES_MIME = "application/vnd.google-apps.presentation";

function link(scope: string, userId = "u1") {
    return { id: CONNECTION, provider: "google", method: "oauth", scope, label: "ana@example.test", userId };
}

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
    for (const mock of [
        getConnection,
        listConnections,
        readCredential,
        getGoogleOAuthClient,
        googleAccessToken,
        importFile,
        createDocument,
        applyUpdate,
        readDocument,
        deleteDocument,
        documentAccess,
        exportDocument,
        officeGoogleFile.create,
        officeGoogleFile.findUnique,
        officeGoogleFile.update,
        fetchMock
    ]) {
        mock.mockReset();
    }
    vi.stubGlobal("fetch", fetchMock);
    getGoogleOAuthClient.mockResolvedValue({ clientId: "client", clientSecret: "secret" });
    getConnection.mockResolvedValue(link(`openid email ${READ} ${WRITE}`));
    readCredential.mockResolvedValue({ refreshToken: "refresh" });
    googleAccessToken.mockResolvedValue("token");
});

describe("the Drive query", () => {
    it("escapes a quote and a backslash in a searched name", () => {
        const query = google.driveOfficeQuery(" it's a \\ test ");
        expect(query).toContain("name contains 'it\\'s a \\\\ test'");
        expect(query).toContain("trashed = false");
        expect(query).toContain(`mimeType = '${DOC_MIME}'`);
    });

    it("asks for no name when nothing was typed", () => {
        expect(google.driveOfficeQuery("   ")).not.toContain("name contains");
    });
});

describe("which accounts Office can use", () => {
    it("says when this Polaris has no Google client", async () => {
        getGoogleOAuthClient.mockResolvedValue(null);
        expect(await google.officeGoogleState("u1")).toEqual({ available: false, accounts: [] });
    });

    it("tells an account linked for Drive from one linked for something else", async () => {
        listConnections.mockResolvedValue([
            { ...link(`openid ${READ} ${WRITE}`), id: "a" },
            { ...link("openid https://www.googleapis.com/auth/calendar"), id: "b" },
            { ...link(READ), id: "c", method: "manual" }
        ]);
        const state = await google.officeGoogleState("u1");
        expect(state.accounts).toEqual([
            { id: "a", label: "ana@example.test", canImport: true, canSave: true },
            { id: "b", label: "ana@example.test", canImport: false, canSave: false }
        ]);
    });
});

describe("listing", () => {
    it("asks Google with the caller's own token and keeps only Office's types", async () => {
        fetchMock.mockResolvedValueOnce(
            json({
                files: [
                    { id: "d1", name: "Plan", mimeType: DOC_MIME, modifiedTime: "2026-10-01T00:00:00Z" },
                    { id: "p1", name: "Deck", mimeType: SLIDES_MIME },
                    { id: "x1", name: "Photo", mimeType: "image/png" }
                ],
                nextPageToken: "more"
            })
        );
        const page = await google.listGoogleOfficeFiles("u1", CONNECTION, "", null);
        expect(getConnection).toHaveBeenCalledWith("u1", CONNECTION);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain("https://www.googleapis.com/drive/v3/files?");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer token");
        expect(page.next).toBe("more");
        expect(page.files.map((file) => [file.id, file.importable])).toEqual([
            ["d1", true],
            ["p1", false]
        ]);
    });

    it("refuses an account that is not the caller's", async () => {
        getConnection.mockResolvedValue(null);
        await expect(google.listGoogleOfficeFiles("u2", CONNECTION, "", null)).rejects.toMatchObject({
            reason: "no-account"
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("asks for the account again when it was linked without Drive", async () => {
        getConnection.mockResolvedValue(link("openid email"));
        await expect(google.listGoogleOfficeFiles("u1", CONNECTION, "", null)).rejects.toMatchObject({
            reason: "relink"
        });
    });

    it("turns Google's 401 into a relink rather than a failure", async () => {
        fetchMock.mockResolvedValueOnce(json({ error: "invalid" }, 401));
        await expect(google.listGoogleOfficeFiles("u1", CONNECTION, "", null)).rejects.toMatchObject({
            reason: "relink"
        });
    });
});

describe("what Google's refusals mean", () => {
    it("says the Drive API is off rather than blaming the file", async () => {
        fetchMock.mockResolvedValueOnce(
            json(
                {
                    error: {
                        code: 403,
                        message: "Google Drive API has not been used in project 123 before or it is disabled.",
                        errors: [{ reason: "accessNotConfigured" }],
                        details: [{ reason: "SERVICE_DISABLED", metadata: { service: "drive.googleapis.com" } }]
                    }
                },
                403
            )
        );
        await expect(google.listGoogleOfficeFiles("u1", CONNECTION, "", null)).rejects.toMatchObject({
            reason: "api-off"
        });
    });

    it("asks for the account again when the grant is too narrow", async () => {
        fetchMock.mockResolvedValueOnce(
            json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, 403)
        );
        await expect(google.listGoogleOfficeFiles("u1", CONNECTION, "", null)).rejects.toMatchObject({
            reason: "relink"
        });
    });

    it("says a plain 403 is a refusal of the file", async () => {
        fetchMock.mockResolvedValueOnce(json({ error: { code: 403, errors: [{ reason: "forbidden" }] } }, 403));
        await expect(google.listGoogleOfficeFiles("u1", CONNECTION, "", null)).rejects.toMatchObject({
            reason: "denied"
        });
    });
});

describe("importing", () => {
    it("exports a Doc as .docx, opens it, and remembers where it came from", async () => {
        fetchMock
            .mockResolvedValueOnce(json({ id: "d1", name: "Q3 / plan", mimeType: DOC_MIME }))
            .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
        importFile.mockResolvedValue({ kind: "doc", title: "Q3 - plan", update: new Uint8Array([9]) });
        createDocument.mockResolvedValue("doc1");

        const made = await google.importGoogleFile({ id: "u1" }, CONNECTION, "d1", null);

        expect(made).toEqual({ id: "doc1", kind: "doc", title: "Q3 - plan" });
        const exportUrl = fetchMock.mock.calls[1]?.[0] as string;
        expect(exportUrl).toContain("/files/d1/export?mimeType=");
        expect(decodeURIComponent(exportUrl)).toContain("wordprocessingml.document");
        expect(importFile).toHaveBeenCalledWith("Q3 - plan.docx", new Uint8Array([1, 2, 3]));
        expect(applyUpdate).toHaveBeenCalledWith({ id: "u1" }, "doc1", new Uint8Array([9]));
        expect(officeGoogleFile.create).toHaveBeenCalledWith({
            data: {
                documentId: "doc1",
                connectionId: CONNECTION,
                sourceFileId: "d1",
                sourceMime: DOC_MIME,
                sourceName: "Q3 / plan"
            }
        });
    });

    it("takes the new document away again when its Google link cannot be written", async () => {
        fetchMock
            .mockResolvedValueOnce(json({ id: "d1", name: "Plan", mimeType: DOC_MIME }))
            .mockResolvedValueOnce(new Response(new Uint8Array([1])));
        importFile.mockResolvedValue({ kind: "doc", title: "Plan", update: new Uint8Array([9]) });
        createDocument.mockResolvedValue("doc1");
        deleteDocument.mockResolvedValue(undefined);
        officeGoogleFile.create.mockRejectedValue(new Error("db down"));

        await expect(google.importGoogleFile({ id: "u1" }, CONNECTION, "d1", null)).rejects.toThrow("db down");
        expect(deleteDocument).toHaveBeenCalledWith({ id: "u1" }, "doc1");
    });

    it("refuses Slides by Google's word, before exporting anything", async () => {
        fetchMock.mockResolvedValueOnce(json({ id: "p1", name: "Deck", mimeType: SLIDES_MIME }));
        await expect(google.importGoogleFile({ id: "u1" }, CONNECTION, "p1", null)).rejects.toMatchObject({
            reason: "not-supported"
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(createDocument).not.toHaveBeenCalled();
    });

    it("stops reading an export past the limit", async () => {
        let pulled = 0;
        const endless = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(1024 * 1024));
            }
        });
        fetchMock
            .mockResolvedValueOnce(json({ id: "d1", name: "Big", mimeType: DOC_MIME }))
            .mockResolvedValueOnce(new Response(endless));
        await expect(google.importGoogleFile({ id: "u1" }, CONNECTION, "d1", null)).rejects.toMatchObject({
            reason: "too-large"
        });
        expect(pulled).toBeLessThan(15);
        expect(createDocument).not.toHaveBeenCalled();
    });
});

describe("saving back", () => {
    const row = {
        documentId: "doc1",
        connectionId: CONNECTION,
        sourceMime: DOC_MIME,
        sourceName: "Plan",
        copyFileId: null as string | null
    };

    beforeEach(() => {
        readDocument.mockResolvedValue({ view: { kind: "doc", title: "Plan" }, content: new Uint8Array([7]) });
        exportDocument.mockResolvedValue({ bytes: new Uint8Array([4, 5]) });
    });

    it("creates a Google copy the first time, converted to a Doc", async () => {
        officeGoogleFile.findUnique.mockResolvedValue({ ...row });
        fetchMock.mockResolvedValueOnce(json({ id: "copy1" }));

        const saved = await google.saveToGoogle({ id: "u1" }, "doc1");

        expect(saved.link).toBe("https://docs.google.com/document/d/copy1/edit");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain("/upload/drive/v3/files?uploadType=multipart");
        expect(init.method).toBe("POST");
        const body = new TextDecoder().decode(init.body as Uint8Array);
        expect(body).toContain(`"mimeType":"${DOC_MIME}"`);
        expect(exportDocument).toHaveBeenCalledWith("doc", "Plan", new Uint8Array([7]), "docx");
        expect(officeGoogleFile.update).toHaveBeenCalledWith({
            where: { documentId: "doc1" },
            data: { copyFileId: "copy1", savedAt: expect.any(Date) }
        });
    });

    it("updates the same copy after that", async () => {
        officeGoogleFile.findUnique.mockResolvedValue({ ...row, copyFileId: "copy1" });
        fetchMock.mockResolvedValueOnce(json({ id: "copy1" }));

        await google.saveToGoogle({ id: "u1" }, "doc1");

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain("/upload/drive/v3/files/copy1?uploadType=media");
        expect(init.method).toBe("PATCH");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("makes a new copy when the old one was deleted in Google", async () => {
        officeGoogleFile.findUnique.mockResolvedValue({ ...row, copyFileId: "gone" });
        fetchMock.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({ id: "copy2" }));

        const saved = await google.saveToGoogle({ id: "u1" }, "doc1");

        expect(saved.link).toContain("/copy2/");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("refuses a reader the account does not belong to", async () => {
        officeGoogleFile.findUnique.mockResolvedValue({ ...row });
        getConnection.mockResolvedValue(null);
        await expect(google.saveToGoogle({ id: "u2" }, "doc1")).rejects.toMatchObject({ reason: "no-account" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses somebody who cannot read the document", async () => {
        officeGoogleFile.findUnique.mockResolvedValue({ ...row });
        readDocument.mockResolvedValue(null);
        await expect(google.saveToGoogle({ id: "u1" }, "doc1")).rejects.toMatchObject({ reason: "not-found" });
    });
});

describe("the multipart body", () => {
    it("carries the metadata, then the bytes, between the boundaries", () => {
        const body = google.multipartBody({ name: "A" }, "text/plain", new TextEncoder().encode("hi"), "b0");
        expect(new TextDecoder().decode(body)).toBe(
            '--b0\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"A"}\r\n--b0\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b0--'
        );
    });
});

describe("the Google side of a document", () => {
    it("says nothing about a document the reader cannot open", async () => {
        documentAccess.mockResolvedValue(null);
        officeGoogleFile.findUnique.mockResolvedValue({
            connectionId: CONNECTION,
            sourceName: "Secret",
            savedAt: null,
            copyFileId: "copy1",
            sourceMime: DOC_MIME
        });

        expect(await google.googleLinkOf("u2", "doc1")).toBeNull();
        expect(officeGoogleFile.findUnique).not.toHaveBeenCalled();
    });

    it("describes it to somebody who can open it", async () => {
        documentAccess.mockResolvedValue({ role: "viewer", owned: false });
        officeGoogleFile.findUnique.mockResolvedValue({
            connectionId: CONNECTION,
            sourceName: "Plan",
            savedAt: null,
            copyFileId: "copy1",
            sourceMime: DOC_MIME
        });
        getConnection.mockResolvedValue(null);

        expect(await google.googleLinkOf("u2", "doc1")).toEqual({
            sourceName: "Plan",
            mine: false,
            savedAt: null,
            copyLink: "https://docs.google.com/document/d/copy1/edit"
        });
        expect(documentAccess).toHaveBeenCalledWith({ id: "u2" }, "doc1");
    });
});
