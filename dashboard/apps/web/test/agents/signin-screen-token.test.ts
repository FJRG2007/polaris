/**
 * Reading the token a login prints as its result.
 *
 * The sample is the end of a real `claude setup-token` run (Claude Code
 * 2.1.323, 2026-11-13) with the token swapped for a fixture of the same length,
 * broken across two lines where the eighty-column terminal broke the real one.
 * Before this the person copied it out of the terminal by hand, and the dialog
 * gave no sign of what to do with it.
 */

import { describe, expect, it } from "vitest";
import { agentSignins } from "@/lib/agents/agent-signins";
import { hasScreenToken, readSigninScreen, screenTokenIn } from "@/lib/agents/signin-screen";

const ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const HEAD = "sk-ant-oat01-FIXTUREfixtureFIXTUREfixtureFIXTUREfixtureFIXTUREfixtureFIXTUR";
const TAIL = "EfixtureFIXTUREfixture-FIXTURE_fixtureFIXTUREAA";

function screen(...token: string[]): string {
    return [
        " This will guide you through long-lived (1-year) auth token setup for your",
        " Claude account. Claude subscription required.",
        "",
        "",
        " ✓ Long-lived authentication token created successfully!",
        "",
        " Your OAuth token (valid for 1 year):",
        "",
        ...token.map((piece) => ` ${piece}`),
        "",
        " Store this token securely. You won't be able to see it again.",
        "",
        " Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>"
    ].join("\n");
}

describe("screenTokenIn", () => {
    it("joins a token the terminal broke across lines", () => {
        expect(screenTokenIn(ENV, screen(HEAD, TAIL))).toBe(`${HEAD}${TAIL}`);
    });

    it("reads one the terminal left whole", () => {
        expect(screenTokenIn(ENV, screen(`${HEAD}${TAIL}`))).toBe(`${HEAD}${TAIL}`);
    });

    it("reads it through the screen cleaning the dialog does", () => {
        expect(screenTokenIn(ENV, readSigninScreen(screen(HEAD, TAIL)).screen)).toBe(`${HEAD}${TAIL}`);
    });

    it("is null before the login has printed one", () => {
        expect(screenTokenIn(ENV, " Opening browser to sign in...\n Paste code here if prompted >")).toBeNull();
    });

    it("never keeps a token cut short or the placeholder in the usage line", () => {
        expect(screenTokenIn(ENV, screen("sk-ant-oat01-short"))).toBeNull();
        expect(screenTokenIn(ENV, " export CLAUDE_CODE_OAUTH_TOKEN=<token>")).toBeNull();
    });

    it("takes the last of two runs in the same terminal", () => {
        const older = `sk-ant-oat01-${"o".repeat(60)}`;
        expect(screenTokenIn(ENV, `${screen(older)}\n${screen(HEAD, TAIL)}`)).toBe(`${HEAD}${TAIL}`);
    });

    it("reads nothing for a credential whose printed form nobody has seen", () => {
        expect(screenTokenIn("GEMINI_API_KEY", screen(HEAD, TAIL))).toBeNull();
        expect(hasScreenToken("GEMINI_API_KEY")).toBe(false);
    });
});

describe("the Claude sign-in", () => {
    it("is kept off the screen, with nothing for the person to copy", () => {
        const claude = agentSignins().find((signin) => signin.env === ENV);
        expect(claude?.onScreen).toBe(true);
        expect(agentSignins().filter((signin) => signin.onScreen).map((signin) => signin.env)).toEqual([ENV]);
    });
});
