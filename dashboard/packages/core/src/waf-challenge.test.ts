/**
 * The browser challenge, end to end on one machine: the guard issues a puzzle, the
 * page's own solver answers it, and the guard accepts the pass - or refuses it for
 * every reason it should.
 *
 * The page's SHA-256 is run here exactly as the browser runs it and compared with
 * Node's. The two disagreeing would not fail loudly anywhere else: every visitor would
 * solve a puzzle the guard never accepts and be asked again, forever.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EDGE_SHA256_JS, wafChallengePage } from "./waf-challenge-page.js";
import { decodeGuardRule, edgeChallengeAnswered, encodeGuardRule, issueEdgeChallenge, verifyEdgePass } from "./waf.js";

const SECRET = "test-secret";
const NOW = 1_800_000_000;

const pageSha256 = new Function(`${EDGE_SHA256_JS}; return sha256;`)() as (input: string) => number[];

/** The digest as Node writes it, from the page's eight words. */
function hex(words: number[]): string {
    return words.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Solve a puzzle the way the page does. */
function solve(challenge: string, bits: number): string {
    for (let counter = 0; ; counter += 1) {
        const first = pageSha256(`${challenge}:${counter}`)[0] ?? 0;
        if ((bits >= 32 ? first : first >>> (32 - bits)) === 0) return String(counter);
    }
}

describe("the page's hash", () => {
    it("matches Node's for every length a puzzle can be", () => {
        for (let length = 0; length < 200; length += 7) {
            const input = "a1.-_:".repeat(40).slice(0, length);
            expect(hex(pageSha256(input)), `length ${length}`).toBe(createHash("sha256").update(input).digest("hex"));
        }
    });
});

describe("a pass", () => {
    const challenge = issueEdgeChallenge({ host: "shop.example.com", ip: "203.0.113.7", now: NOW, nonce: "n1", bits: 8 }, SECRET);
    const pass = `${challenge}.${solve(challenge, 8)}`;

    it("is accepted when the page solved the puzzle the guard issued", () => {
        expect(edgeChallengeAnswered(challenge, solve(challenge, 8), 8)).toBe(true);
        expect(verifyEdgePass(pass, SECRET, NOW + 60, "shop.example.com", "203.0.113.7")).toBe(true);
    });

    it("is refused on another host, from another address, or once it has aged out", () => {
        expect(verifyEdgePass(pass, SECRET, NOW + 60, "other.example.com", "203.0.113.7")).toBe(false);
        expect(verifyEdgePass(pass, SECRET, NOW + 60, "shop.example.com", "198.51.100.1")).toBe(false);
        expect(verifyEdgePass(pass, SECRET, NOW + 31 * 60, "shop.example.com", "203.0.113.7")).toBe(false);
    });

    it("is refused with a wrong answer, a forged puzzle or no secret", () => {
        const wrong = `${challenge}.${Number(solve(challenge, 8)) + 1}`;
        // One answer in 256 is also a right one at 8 bits, so only claim it is refused
        // when it really does not meet the difficulty.
        if (!edgeChallengeAnswered(challenge, wrong.slice(challenge.length + 1), 8)) {
            expect(verifyEdgePass(wrong, SECRET, NOW + 60, "shop.example.com", "203.0.113.7")).toBe(false);
        }
        const forged = issueEdgeChallenge({ host: "shop.example.com", ip: "203.0.113.7", now: NOW, nonce: "n1", bits: 1 }, "not-the-secret");
        expect(verifyEdgePass(`${forged}.${solve(forged, 1)}`, SECRET, NOW + 60, "shop.example.com", "203.0.113.7")).toBe(false);
        expect(verifyEdgePass(pass, "", NOW + 60, "shop.example.com", "203.0.113.7")).toBe(false);
    });
});

describe("the rule header", () => {
    it("carries the challenge only when it is on", () => {
        const base = { deny: [], requireLogin: false, rules: [] };
        expect(decodeGuardRule(encodeGuardRule({ ...base, challenge: true })).challenge).toBe(true);
        expect(decodeGuardRule(encodeGuardRule(base)).challenge).toBe(false);
        expect(Buffer.from(encodeGuardRule(base), "base64").toString()).not.toContain('"c"');
    });
});

describe("the page", () => {
    it("runs its script by nonce and fetches nothing from anywhere", () => {
        const page = wafChallengePage({
            challenge: "abc.def",
            bits: 16,
            cookieName: "polaris.pass",
            maxAge: 1800,
            secure: true,
            nonce: "n0nce",
            host: "shop.example.com",
            ip: "203.0.113.7"
        });
        expect(page).toContain('<script nonce="n0nce">');
        expect(page).toContain("; Secure");
        expect(page).not.toMatch(/src="http/);
    });
});
