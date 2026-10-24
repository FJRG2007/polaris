/**
 * A delegate's message names them in `Sender:` while `From:` stays the
 * mailbox's own (RFC 5322 3.6.2), and an ordinary message carries no Sender.
 */

import { describe, expect, it } from "vitest";
import { composeMime, type OutgoingMessage } from "@/lib/mailbox/send";

const message: OutgoingMessage = {
    from: { name: "Boss", address: "boss@example.test" },
    to: [{ name: "", address: "ana@example.test" }],
    cc: [],
    bcc: [],
    replyTo: "",
    subject: "Plans",
    body: "Yes",
    attachments: [],
    inReplyTo: "",
    references: [],
    requestReceipt: false
};

describe("the Sender header", () => {
    it("names the delegate on a message sent on the holder's behalf", async () => {
        const { mime } = await composeMime({
            ...message,
            sender: { name: "Helper", address: "helper@example.test" }
        });
        const head = mime.toString("utf8").split("\r\n\r\n")[0] ?? "";
        expect(head).toMatch(/^From: Boss <boss@example\.test>$/m);
        expect(head).toMatch(/^Sender: Helper <helper@example\.test>$/m);
    });

    it("is absent on everything else", async () => {
        const { mime } = await composeMime(message);
        expect(mime.toString("utf8").split("\r\n\r\n")[0]).not.toMatch(/^Sender:/m);
    });
});
