/**
 * The reverse name, graded.
 *
 * The case that matters most is the one in the middle: a reverse name exists
 * and is not the greeting name. That is not a failure - mail from it is
 * accepted nearly everywhere - and grading it as one would send somebody
 * chasing their hosting provider over a server that works. The failures are the
 * two a receiver reads as "no reverse name at all": none published, and one
 * that does not resolve back.
 */

import * as ptr from "./mail-ptr.js";
import { describe, expect, it } from "vitest";

function lookup(over: Partial<ptr.MailReverseLookup> = {}): ptr.MailReverseLookup {
    return {
        hostname: "mail.example.com",
        address: "198.51.100.20",
        pointers: ["mail.example.com"],
        pointerAddresses: ["198.51.100.20"],
        hostAddresses: ["198.51.100.20"],
        ...over
    };
}

describe("the reverse name of the address mail leaves from", () => {
    it("passes when it exists, resolves back, and is the greeting name", () => {
        const graded = ptr.gradeReverseName(lookup());
        expect(graded.verdict).toBe("pass");
        expect(graded.instruction).toBe("");
    });

    it("fails when there is none, and says who sets one", () => {
        const graded = ptr.gradeReverseName(lookup({ pointers: [] }));
        expect(graded.verdict).toBe("fail");
        expect(graded.instruction).toContain("hosting provider");
        expect(graded.instruction).toContain("198.51.100.20");
        expect(graded.instruction).toContain("mail.example.com");
    });

    it("fails a reverse name that does not resolve back to the address", () => {
        const graded = ptr.gradeReverseName(
            lookup({ pointers: ["claimed.example.net"], pointerAddresses: ["203.0.113.9"] })
        );
        expect(graded.verdict).toBe("fail");
        expect(graded.note).toContain("does not resolve back");
    });

    it("only warns when it resolves back but names something else", () => {
        const graded = ptr.gradeReverseName(
            lookup({ pointers: ["smtp-out.example.com"], pointerAddresses: ["198.51.100.20"] })
        );
        expect(graded.verdict).toBe("warn");
        expect(graded.pointer).toBe("smtp-out.example.com");
    });

    it("warns about a name a provider hands out in a block", () => {
        const graded = ptr.gradeReverseName(
            lookup({
                hostname: "198-51-100-20.static.example.net",
                pointers: ["198-51-100-20.static.example.net"]
            })
        );
        expect(graded.verdict).toBe("warn");
    });

    it("says nothing could be checked rather than passing or failing", () => {
        expect(ptr.gradeReverseName(lookup({ address: null })).verdict).toBe("unverified");
        expect(ptr.gradeReverseName(lookup({ pointers: null })).verdict).toBe("unverified");
    });
});

describe("the name the server greets with", () => {
    it("passes when it resolves to the sending address", () => {
        expect(ptr.gradeGreetingName(lookup()).verdict).toBe("pass");
    });

    it("fails when it does not resolve at all", () => {
        const graded = ptr.gradeGreetingName(lookup({ hostAddresses: [] }));
        expect(graded.verdict).toBe("fail");
        expect(graded.instruction).toContain("A record");
    });

    it("warns when it resolves somewhere else", () => {
        const graded = ptr.gradeGreetingName(lookup({ hostAddresses: ["203.0.113.9"] }));
        expect(graded.verdict).toBe("warn");
        expect(graded.note).toContain("203.0.113.9");
    });

    it("cannot check it against nothing", () => {
        expect(ptr.gradeGreetingName(lookup({ hostAddresses: null })).verdict).toBe("unverified");
        expect(ptr.gradeGreetingName(lookup({ address: null })).verdict).toBe("unverified");
    });
});

describe("one badge over the pair", () => {
    it("takes the worse of the two, and never calls an unchecked pair a pass", () => {
        const at = (verdict: ptr.MailReverseVerdict): ptr.MailReverseCheck => ({
            verdict,
            pointer: "",
            note: "",
            instruction: ""
        });
        expect(ptr.reverseOverall([at("pass"), at("fail")])).toBe("fail");
        expect(ptr.reverseOverall([at("pass"), at("warn")])).toBe("warn");
        expect(ptr.reverseOverall([at("pass"), at("pass")])).toBe("pass");
        expect(ptr.reverseOverall([at("pass"), at("unverified")])).toBe("unverified");
        expect(ptr.reverseOverall([])).toBe("unverified");
    });

    it("compares names without caring about a trailing dot or case", () => {
        expect(ptr.sameName("Mail.Example.com.", "mail.example.com")).toBe(true);
        expect(ptr.sameName("", "")).toBe(false);
    });
});
