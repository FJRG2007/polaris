/**
 * Linking a deployment's commit to the forge it came from. The rule being
 * protected: only a host whose commit path is actually known produces a link -
 * a plausible-looking URL that 404s is worse than the plain SHA it replaced.
 */

import { describe, expect, it } from "vitest";
import { commitUrl } from "../../src/lib/deploy/commit-url";

const SHA = "80dbf0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7";

describe("commitUrl", () => {
    it("places a GitHub commit from every clone-URL form a service can be given", () => {
        const expected = `https://github.com/FJRG2007/polaris/commit/${SHA}`;
        expect(commitUrl("https://github.com/FJRG2007/polaris.git", SHA)).toBe(expected);
        expect(commitUrl("https://github.com/FJRG2007/polaris", SHA)).toBe(expected);
        expect(commitUrl("https://github.com/FJRG2007/polaris/", SHA)).toBe(expected);
        expect(commitUrl("git@github.com:FJRG2007/polaris.git", SHA)).toBe(expected);
        expect(commitUrl("ssh://git@github.com/FJRG2007/polaris.git", SHA)).toBe(expected);
    });

    it("uses GitLab's own commit path rather than GitHub's", () => {
        expect(commitUrl("https://gitlab.com/group/app.git", SHA)).toBe(`https://gitlab.com/group/app/-/commit/${SHA}`);
    });

    it("keeps a nested group path intact", () => {
        expect(commitUrl("https://gitlab.com/group/sub/app", SHA)).toBe(
            `https://gitlab.com/group/sub/app/-/commit/${SHA}`
        );
    });

    it("reads past the credentials a private repo is cloned with", () => {
        const expected = `https://github.com/FJRG2007/polaris/commit/${SHA}`;
        expect(commitUrl("https://x-access-token:TOKEN@github.com/FJRG2007/polaris.git", SHA)).toBe(expected);
        expect(commitUrl("https://user@github.com/FJRG2007/polaris", SHA)).toBe(expected);
    });

    it("never lets the credentials stand in for the host the clone goes to", () => {
        // The host is where the repository actually lives; whatever precedes the
        // "@" is a username, and treating it as the host is how a link ends up
        // pointing at a repository that is not the one being deployed.
        expect(commitUrl("https://github.com@git.example.com/o/r", SHA)).toBeNull();
        expect(commitUrl("https://evil.com@github.com/o/r", SHA)).toBe(`https://github.com/o/r/commit/${SHA}`);
    });

    it("does not read an explicit port as the first path segment", () => {
        expect(commitUrl("ssh://git@github.com:22/FJRG2007/polaris.git", SHA)).toBe(
            `https://github.com/FJRG2007/polaris/commit/${SHA}`
        );
        expect(commitUrl("https://github.com:443/FJRG2007/polaris", SHA)).toBe(
            `https://github.com/FJRG2007/polaris/commit/${SHA}`
        );
    });

    it("keeps the credentials out of the link it emits", () => {
        const url = commitUrl("https://x-access-token:TOKEN@github.com/FJRG2007/polaris.git", SHA);
        expect(url).not.toContain("TOKEN");
        expect(url).not.toContain("@");
    });

    it("offers no link for a host whose commit path it cannot know", () => {
        expect(commitUrl("https://git.example.com/team/app.git", SHA)).toBeNull();
        expect(commitUrl("", SHA)).toBeNull();
    });

    it("offers no link without a commit - an image deploy has none", () => {
        expect(commitUrl("https://github.com/FJRG2007/polaris", "")).toBeNull();
    });
});
