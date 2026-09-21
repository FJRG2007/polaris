// @vitest-environment jsdom
/**
 * The one sender every screen uses.
 *
 * It is built on `XMLHttpRequest` and that is the whole point of it: `fetch` has no
 * upload-progress event, so a ten-minute upload through `fetch` is ten minutes of a
 * screen that knows nothing, and there is no way to report what it cannot see.
 *
 * What is pinned: the bar moves from the request's own progress, a refused upload
 * shows the sentence the server wrote rather than a generic one, a dropped
 * connection is not reported as a refusal, and a form goes as a form - because
 * overriding its content type is how a multipart body arrives unparseable, and that
 * is the kind of mistake a test has to catch rather than a person.
 */

import { sendFile } from "@/components/transfers/move-file";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTransfer, transfersNow } from "@/components/transfers/transfer-store";

/** One request, as the sender drives it. */
class FakeRequest {
    public static last: FakeRequest | null = null;

    public readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
    public onload: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public onabort: (() => void) | null = null;
    public status = 0;
    public responseText = "";
    public sent: unknown = null;
    public opened: { method: string; url: string } | null = null;
    public readonly headers: Record<string, string> = {};

    constructor() {
        FakeRequest.last = this;
    }

    public open(method: string, url: string): void {
        this.opened = { method, url };
    }

    public setRequestHeader(header: string, value: string): void {
        this.headers[header] = value;
    }

    public send(payload: unknown): void {
        this.sent = payload;
    }

    public abort(): void {
        this.onabort?.();
    }

    /** What the browser does as the body goes out. */
    public progress(loaded: number, total: number): void {
        this.upload.onprogress?.({
            lengthComputable: true,
            loaded,
            total
        } as ProgressEvent);
    }

    /** What it does when the answer arrives. */
    public answer(status: number, body = ""): void {
        this.status = status;
        this.responseText = body;
        this.onload?.();
    }
}

beforeEach(() => {
    for (const transfer of transfersNow()) clearTransfer(transfer.id);
    FakeRequest.last = null;
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function file(name = "holiday.mp4", size = 1000, type = "video/mp4"): File {
    const blob = new Blob([new Uint8Array(size)], { type });
    return new File([blob], name, { type });
}

describe("sending one file", () => {
    it("reports what the request reports, and finishes when it answers", async () => {
        const sending = sendFile("/api/chat/channels/c1/uploads?name=holiday.mp4", file());
        const request = FakeRequest.last!;
        expect(request.opened).toEqual({
            method: "PUT",
            url: "/api/chat/channels/c1/uploads?name=holiday.mp4"
        });
        // The type travels as the header, because the body is the file itself.
        expect(request.headers["Content-Type"]).toBe("video/mp4");

        request.progress(400, 1000);
        const moving = transfersNow()[0]!;
        expect(moving.state).toBe("moving");
        expect(moving.moved).toBe(400);
        expect(moving.total).toBe(1000);

        request.answer(200, JSON.stringify({ id: "u1" }));
        const sent = await sending;
        expect(sent.ok).toBe(true);
        expect(sent.body).toBe('{"id":"u1"}');
        expect(transfersNow()[0]!.state).toBe("done");
    });

    it("shows the sentence the server wrote about a file it refused", async () => {
        const sending = sendFile("/api/chat/channels/c1/uploads?name=holiday.mp4", file());
        FakeRequest.last!.answer(413, JSON.stringify({ error: "holiday.mp4 is bigger than 25 MB" }));
        const sent = await sending;
        expect(sent.ok).toBe(false);
        expect(sent.status).toBe(413);
        // The refusal said exactly what to do about it; "that could not be sent"
        // would have thrown that away.
        expect(transfersNow()[0]!.error).toBe("holiday.mp4 is bigger than 25 MB");
    });

    it("says a dropped connection is a connection rather than a refusal", async () => {
        const sending = sendFile("/api/chat/channels/c1/uploads?name=holiday.mp4", file());
        FakeRequest.last!.onerror?.();
        const sent = await sending;
        expect(sent.status).toBe(0);
        expect(transfersNow()[0]!.error).toContain("connection");
    });

    it("can be stopped from the list, and says so", async () => {
        const sending = sendFile("/api/chat/channels/c1/uploads?name=holiday.mp4", file());
        transfersNow()[0]!.stop!();
        await sending;
        expect(transfersNow()[0]!.state).toBe("stopped");
    });
});

describe("sending a form", () => {
    it("lets the browser set its own content type, boundary and all", async () => {
        const form = new FormData();
        form.set("file", file("notes.pdf", 2048, "application/pdf"));

        const sending = sendFile("/api/mail/uploads", form);
        const request = FakeRequest.last!;
        // POST by default for a form, because that is what the routes taking one
        // expect, and no content type of ours: setting it strips the boundary and
        // the body arrives unparseable.
        expect(request.opened!.method).toBe("POST");
        expect(request.headers["Content-Type"]).toBeUndefined();
        expect(request.sent).toBe(form);
        // Named after the file inside it rather than after the field.
        expect(transfersNow()[0]!.name).toBe("notes.pdf");
        expect(transfersNow()[0]!.total).toBe(2048);

        request.answer(200, "{}");
        await sending;
    });
});
