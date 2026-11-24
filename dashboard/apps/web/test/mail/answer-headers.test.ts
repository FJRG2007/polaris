/**
 * Mail-Followup-To and List-Post, read off a stored message for answering it.
 *
 * Stored raw, the way the server sent them, so a name can still be an encoded
 * word and the list's address sits inside a bracketed URL.
 */

import { describe, expect, it } from "vitest";
import { answerHeaders, listPostAddress } from "@/lib/mailbox/answer-headers";

describe("answer headers", () => {
    it("decodes Mail-Followup-To into addresses", async () => {
        const read = await answerHeaders({
            "mail-followup-to": "=?UTF-8?Q?Jos=C3=A9?= <Jose@X.org>, list@x.org"
        });
        expect(read.followupTo).toEqual([
            { name: "José", address: "jose@x.org" },
            { name: "", address: "list@x.org" }
        ]);
        expect(read.listPost).toBe("");
    });

    it("takes the mailto address from List-Post, and nothing from NO", () => {
        expect(listPostAddress("<mailto:Dev@Lists.example.org>")).toBe("dev@lists.example.org");
        expect(
            listPostAddress(
                "<https://lists.example.org/post>, <mailto:dev@lists.example.org?subject=hi>"
            )
        ).toBe("dev@lists.example.org");
        expect(listPostAddress("NO")).toBe("");
        expect(listPostAddress("")).toBe("");
    });

    it("answers with nothing for a message stored before they were fetched", async () => {
        expect(await answerHeaders(null)).toEqual({ followupTo: [], listPost: "" });
        expect(await answerHeaders({ "list-id": "<dev.example.org>" })).toEqual({
            followupTo: [],
            listPost: ""
        });
    });
});
