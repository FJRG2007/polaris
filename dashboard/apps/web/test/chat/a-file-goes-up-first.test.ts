/**
 * The conversation uploads a file before the message that carries it.
 *
 * This is the shape of the change rather than a detail of it, and it cannot be seen
 * from either end on its own: the route takes ids, the composer sends files, and the
 * thing that has to stay true is that the two halves agree about the order. Read as
 * source, because rendering the whole conversation to watch two requests go out
 * would be a test about mocks.
 *
 * What is held:
 *
 * - the file goes through the shared sender, which is what puts a bar on screen and
 *   is the only way to report progress at all;
 * - the message names what was written rather than carrying it;
 * - a send that fails part-way takes the files that did go up back off the storage,
 *   instead of leaving them for the sweep;
 * - the stills and the sound measurements still ride the message, because they are
 *   kilobytes and the server cannot make them.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const VIEW = readFileSync(
    join(process.cwd(), "src/app/(app)/chat/channel-view.tsx"),
    "utf8"
);
const ROUTE = readFileSync(
    join(process.cwd(), "src/app/api/chat/channels/[channelId]/messages/route.ts"),
    "utf8"
);
const UPLOADS = readFileSync(
    join(process.cwd(), "src/app/api/chat/channels/[channelId]/uploads/route.ts"),
    "utf8"
);

describe("the composer", () => {
    it("sends each file to the streaming route, through the shared sender", () => {
        expect(VIEW).toContain("import { sendFile }");
        expect(VIEW).toContain("/api/chat/channels/${channelId}/uploads?");
        expect(VIEW).toMatch(/await sendFile\(/);
    });

    it("names what was uploaded on the message rather than attaching it again", () => {
        expect(VIEW).toContain('form.set("uploads", JSON.stringify(uploaded))');
        // And no longer puts the bytes in the form: that door still exists on the
        // server for anything small, but nothing the composer sends uses it - a
        // message sent now and one scheduled for the morning go the same way.
        expect(VIEW).not.toContain('form.append("files", file)');
    });

    it("takes back what went up when the send fails part-way", () => {
        expect(VIEW).toContain("uploaded.map((id) => discardUpload(channelId, id))");
        expect(VIEW).toContain('method: "DELETE"');
    });

    it("still sends the stills and the sound measurements with the message", () => {
        expect(VIEW).toContain('form.append("posters"');
        expect(VIEW).toContain('form.set("sounds", JSON.stringify(sounds))');
    });
});

describe("the send route", () => {
    it("takes the ids, and puts them before the files in the form", () => {
        expect(ROUTE).toContain('readUploads(form.get("uploads"))');
        expect(ROUTE).toContain("await claimUploads(");
        // The order everything else is indexed against: uploads, then the files in
        // the form, then the ones being shared out of a Drive.
        expect(ROUTE).toContain("const position = uploads.length + at;");
        expect(ROUTE).toContain("covered.has(uploads.length + files.length + at)");
    });

    it("counts everything a message carries against the instance's limit", () => {
        expect(ROUTE).toContain("const carrying = uploads.length + files.length + borrowed.length;");
        expect(ROUTE).toContain("if (carrying > rules.maxAttachments)");
    });

    it("keeps the door that holds a file in memory to its own much lower limit", () => {
        // The instance's limit is about disks now and is measured in gigabytes; a
        // file read out of this request is still held whole while that happens.
        expect(ROUTE).toContain("Math.min(biggest, MAX_ATTACHMENT_BYTES)");
        expect(ROUTE).toContain("has to be uploaded before the message it goes on");
    });
});

describe("the upload route", () => {
    it("applies every gate before it reads a byte", () => {
        const guard = UPLOADS.indexOf("requirePostable");
        const attach = UPLOADS.indexOf('can(user.id, "chat.attach")');
        const rules = UPLOADS.indexOf("await rulesForChannel(");
        const body = UPLOADS.indexOf("stageUpload(");
        expect(guard).toBeGreaterThan(-1);
        expect(attach).toBeGreaterThan(guard);
        expect(rules).toBeGreaterThan(attach);
        expect(body).toBeGreaterThan(rules);
    });

    it("caps the stream as well as reading the declared size", () => {
        // `content-length` is the sender's own claim, so it saves a pointless
        // upload and settles nothing: the cap is what actually holds.
        expect(UPLOADS).toContain('request.headers.get("content-length")');
        expect(UPLOADS).toContain("cappedStream(request.body, biggest)");
        expect(UPLOADS).toContain("{ status: 413 }");
    });
});
