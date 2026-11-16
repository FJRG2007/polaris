/**
 * The address a sign-in's button opens.
 *
 * The Copilot and Claude screens are what those logins really printed (see
 * signin-screen.test.ts and session-commands.test.ts). The others are written
 * in the shape each tool's documentation describes and laid out at the
 * dialog's eighty columns, which is where a tool that wraps its own text breaks
 * a long address into rows that tmux's joined capture cannot mend.
 */

import { describe, expect, it } from "vitest";
import { SIGNIN_COLS } from "@/lib/agents/session-commands";
import { readSigninScreen, signinUrlIn, urlsIn } from "@/lib/agents/signin-screen";

const CURSOR_URL =
    "https://cursor.com/loginDeepControl?challenge=Xq2b9wR0pZk3Lm7Nv8Ty1Uc4Hs6Jd5Fg0Ae2Bi9Ko3&uuid=7f3c2a91-5b4e-4d8f-9a6c-1e2d3f4a5b6c&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true";

/** A long string broken every `width` characters, the way a TUI hard-wraps. */
function rows(text: string, width: number): string[] {
    const out: string[] = [];
    for (let at = 0; at < text.length; at += width) out.push(text.slice(at, at + width));
    return out;
}

describe("the address a login wants opened", () => {
    it("mends Cursor's address when the tool broke it at the edge", () => {
        const screen = ["Open the following link to log in:", "", ...rows(CURSOR_URL, SIGNIN_COLS), "", "Waiting for login..."].join("\n");
        // Read as before, the first row alone was the address: a page that errors.
        expect(screen.split("\n")[2]).toHaveLength(SIGNIN_COLS);
        expect(signinUrlIn(screen)).toBe(CURSOR_URL);
    });

    it("mends it inside a box with a border and padding", () => {
        const inner = SIGNIN_COLS - 4;
        const boxed = rows(CURSOR_URL, inner).map((row) => `│ ${row.padEnd(inner)} │`);
        const screen = ["╭" + "─".repeat(SIGNIN_COLS - 2) + "╮", ...boxed, "╰" + "─".repeat(SIGNIN_COLS - 2) + "╯"].join("\n");
        expect(signinUrlIn(screen)).toBe(CURSOR_URL);
    });

    it("reads Cursor's address joined on one line, as tmux mends a terminal wrap", () => {
        expect(readSigninScreen(`Open the following link to log in:\n${CURSOR_URL}\n`).url).toBe(CURSOR_URL);
    });

    it("reads Claude's", () => {
        const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference";
        const screen = [" Browser didn't open? Use the url below to sign in (c to copy)", "", url, "", " Paste code here if prompted >"].join("\n");
        expect(signinUrlIn(screen)).toBe(url);
    });

    it("reads Copilot's from a sentence, without the sentence", () => {
        const screen = "To authenticate, visit https://github.com/login/device and enter code 37FB-F903\nWaiting for authorization...";
        expect(signinUrlIn(screen)).toBe("https://github.com/login/device");
    });

    it("reads Codex's device page", () => {
        const screen = [
            "1. Open this link in your browser and sign in to your account",
            "   https://auth.openai.com/codex/device",
            "",
            "2. Enter this one-time code (expires in 15 minutes)",
            "   ABCD-12345"
        ].join("\n");
        expect(signinUrlIn(screen)).toBe("https://auth.openai.com/codex/device");
    });

    it("reads Gemini's consent address", () => {
        const url =
            "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&access_type=offline&scope=openid&code_challenge_method=S256&response_type=code&client_id=123.apps.googleusercontent.com";
        const screen = ["Please visit the following URL to authorize the application:", "", url, "", "Enter the authorization code:"].join("\n");
        expect(signinUrlIn(screen)).toBe(url);
    });

    it("reads a localhost callback a tool waits on", () => {
        expect(signinUrlIn("go to http://localhost:1455/auth to continue")).toBe("http://localhost:1455/auth");
    });

    it("prefers the sign-in address over a documentation link printed after it", () => {
        const screen = ["Visit https://kiro.dev/device?user_code=ABCD-EFGH to sign in", "Docs: https://kiro.dev/docs/cli"].join("\n");
        expect(signinUrlIn(screen)).toBe("https://kiro.dev/device?user_code=ABCD-EFGH");
    });

    it("takes the newer of two sign-in addresses", () => {
        const screen = ["Visit https://example.com/device?code=OLD1", "Code expired.", "Visit https://example.com/device?code=NEW2"].join("\n");
        expect(signinUrlIn(screen)).toBe("https://example.com/device?code=NEW2");
    });

    it("does not glue the next row to an address that ended short of the edge", () => {
        expect(urlsIn("visit https://github.com/login/device\nand enter code 37FB-F903")).toEqual(["https://github.com/login/device"]);
    });

    it("does not glue a sentence that follows a full row ending in a word", () => {
        const full = `${"x".repeat(SIGNIN_COLS - 20)} end of a sentence.`.slice(0, SIGNIN_COLS);
        expect(urlsIn(`${full}\nhttps://example.com/a`)).toEqual(["https://example.com/a"]);
    });

    it("leaves the punctuation a sentence put around it, and says nothing for nothing", () => {
        expect(signinUrlIn("open (https://example.com/a/b).")).toBe("https://example.com/a/b");
        expect(signinUrlIn("")).toBeNull();
        expect(signinUrlIn("file:///etc/passwd")).toBeNull();
        expect(signinUrlIn("https://")).toBeNull();
    });
});
