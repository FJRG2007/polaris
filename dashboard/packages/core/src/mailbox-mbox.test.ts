/**
 * The mbox framing, both directions.
 *
 * Everything here is about one failure: a line inside a message that begins
 * `From ` being read as the start of the next message. That splits an archive in
 * half at the first forwarded header it contains, and nobody finds out until
 * they open the file years later, which is why the round trip is tested rather
 * than each direction on its own.
 */

import * as mbox from "./mailbox-mbox.js";
import { describe, expect, it } from "vitest";

const AT = new Date("2026-09-08T10:00:00.000Z");

describe("escaping a body", () => {
    it("marks a line that would be read as a separator", () => {
        expect(mbox.escapeMboxBody("hello\nFrom Maya\nbye")).toBe("hello\n>From Maya\nbye");
    });

    it("escapes one that was already escaped, so the escaping can be undone", () => {
        expect(mbox.escapeMboxBody(">From Maya")).toBe(">>From Maya");
    });

    it("leaves a From header alone, because it has a colon", () => {
        expect(mbox.escapeMboxBody("From: maya@example.net")).toBe("From: maya@example.net");
    });

    it("leaves the word alone in the middle of a line", () => {
        expect(mbox.escapeMboxBody("a note From Maya")).toBe("a note From Maya");
    });
});

describe("the separator line", () => {
    it("names the sender and the day", () => {
        expect(mbox.mboxFromLine("maya@example.net", AT)).toContain("maya@example.net");
        expect(mbox.mboxFromLine("maya@example.net", AT)).toMatch(/^From /);
    });

    it("falls back to the traditional name when there is no sender", () => {
        expect(mbox.mboxFromLine("", AT)).toContain("MAILER-DAEMON");
    });
});

describe("a file of messages", () => {
    const first = "Subject: One\n\nHello\nFrom the desk of Maya\n";
    const second = "Subject: Two\n\nBye";

    it("comes back exactly as it went in", () => {
        const file =
            mbox.mboxEntry(first, "a@example.net", AT) + mbox.mboxEntry(second, "b@example.net", AT);
        const read = mbox.readMbox(file);
        expect(read).toHaveLength(2);
        expect(read[0]).toBe(first.replace(/\n*$/, ""));
        expect(read[1]).toBe(second);
    });

    it("does not split on a From line inside a message", () => {
        // The failure this whole file exists for.
        const file = mbox.mboxEntry(first, "a@example.net", AT);
        expect(mbox.readMbox(file)).toHaveLength(1);
    });

    it("reads a file written by something that never escaped anything", () => {
        // Other clients are not careful. A `From ` line that is not preceded by
        // a blank line is not a separator, which is what saves this case.
        const sloppy = [
            "From a@example.net Mon Sep  8 10:00:00 2026",
            "Subject: One",
            "",
            "Hello",
            "From the desk of Maya",
            "",
            "From b@example.net Mon Sep  8 10:00:00 2026",
            "Subject: Two",
            "",
            "Bye"
        ].join("\n");
        const read = mbox.readMbox(sloppy);
        expect(read).toHaveLength(2);
        expect(read[0]).toContain("From the desk of Maya");
        expect(read[1]).toContain("Subject: Two");
    });

    it("has nothing to say about an empty file", () => {
        expect(mbox.readMbox("")).toEqual([]);
        expect(mbox.readMbox("\n\n\n")).toEqual([]);
    });

    it("reads a file with no separator at all as one message", () => {
        // Somebody renamed a .eml. Answering with nothing would be worse than
        // answering with the message that is plainly in there.
        expect(mbox.readMbox("Subject: One\n\nHello")).toEqual(["Subject: One\n\nHello"]);
    });
});

describe("what the file is called", () => {
    it("is the address and the day", () => {
        expect(mbox.mboxFilename("maya@example.net", AT)).toBe("maya-example.net-2026-09-08.mbox");
    });

    it("never carries a character that would escape a directory", () => {
        expect(mbox.mboxFilename("../../etc/passwd", AT)).not.toContain("/");
        expect(mbox.mboxFilename("../../etc/passwd", AT)).not.toContain("..");
    });
});
