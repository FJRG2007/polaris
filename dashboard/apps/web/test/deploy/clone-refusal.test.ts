/**
 * A private repository, refused, said to whoever pressed Deploy.
 *
 * What git says here is about a terminal: it wanted a username, there was no
 * terminal to ask at, and it reported that as the errno of a missing device -
 * "could not read Username for 'https://github.com': No such device or address",
 * exit 128. That is the truth about the process and says nothing about what to
 * do, and Polaris was passing it straight through as the reason the deploy
 * failed.
 *
 * The two account cases are told apart on purpose. Nothing connected means the
 * clone went out as nobody and connecting an account fixes it; a credential that
 * was sent and refused means the account is linked and cannot see this
 * repository, which is somewhere else to go. Anything that is not about an
 * account keeps git's own words, which for a broken build are the useful ones.
 */

import { describe, expect, it } from "vitest";
import { cloneRefusal } from "../../src/lib/git-build-service";

const REPO = { repoUrl: "https://github.com/acme/widgets.git" };
const WITH_ACCOUNT = { ...REPO, authHeader: "Authorization: Basic redacted" };

/** What the deploy log held when this was reported. */
const NO_TERMINAL =
    "Cloning into '/tmp/polaris-build-UgEy4r'...\nfatal: could not read Username for 'https://github.com': No such device or address\n";

describe("a clone that was refused for want of an account", () => {
    it("says what to do instead of what git could not read", () => {
        const said = cloneRefusal(NO_TERMINAL, REPO);
        expect(said).toContain("github.com/acme/widgets");
        expect(said).toContain("Connect the account");
        expect(said).not.toContain("Username");
    });

    it("names the repository without the scheme or the .git nobody typed", () => {
        expect(cloneRefusal(NO_TERMINAL, REPO)?.startsWith("github.com/acme/widgets ")).toBe(true);
    });

    it("recognizes it however git happened to phrase it", () => {
        for (const line of [
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "remote: Repository not found.",
            "fatal: Authentication failed for 'https://github.com/acme/widgets.git/'",
            "fatal: unable to access '...': The requested URL returned error: 403"
        ]) {
            expect(cloneRefusal(line, REPO)).not.toBeNull();
        }
    });
});

describe("a clone that went out with a credential and was still refused", () => {
    it("sends the reader to the account rather than to connecting one they have", () => {
        const said = cloneRefusal("remote: Repository not found.", WITH_ACCOUNT);
        expect(said).toContain("refused the connected account");
        expect(said).not.toContain("Connect the account that can see it");
    });
});

describe("a clone that failed for any other reason", () => {
    it("keeps git's own words, which are the ones worth reading", () => {
        expect(cloneRefusal("fatal: Remote branch nope not found in upstream origin\n", REPO)).toBeNull();
        expect(cloneRefusal("error: could not create work tree dir: Permission denied\n", REPO)).toBeNull();
        expect(cloneRefusal("", REPO)).toBeNull();
    });
});
