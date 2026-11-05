/**
 * The GitHub credential a session's agent works with: refused rather than
 * borrowed from another account's installation, scoped to one repository, and
 * never held by the agent - its git asks Polaris through a credential helper.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import * as scoping from "@/lib/github-installation-scope";
import * as commands from "@/lib/agents/session-commands";
import { gitCredentialScript } from "@/lib/agents/session-hooks";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which installation a session's token comes from", () => {
    const installs = [
        { id: 1, login: "first-org" },
        { id: 2, login: "Acme" }
    ];

    it("finds the owner's own installation, in any case", () => {
        expect(scoping.installationFor(installs, "acme")?.id).toBe(2);
    });

    it("refuses an owner nobody installed the App on instead of using the first one", () => {
        expect(scoping.installationFor(installs, "someone-else")).toBeNull();
        expect(scoping.installationFor(installs, "")).toBeNull();
    });
});

describe("what a session's token may reach", () => {
    it("names one repository and the permission asked for", () => {
        const scoped = scoping.repositoryScope("Acme/site", scoping.AGENT_GIT_PERMISSIONS);
        expect(scoped).toEqual({
            owner: "Acme",
            scope: { repositories: ["site"], permissions: { contents: "write" } }
        });
        expect(JSON.parse(scoping.installationTokenBody(scoped!.scope)!)).toEqual({
            repositories: ["site"],
            permissions: { contents: "write" }
        });
    });

    it("clones with read access only", () => {
        expect(
            scoping.repositoryScope("a/b", scoping.CLONE_PERMISSIONS)?.scope.permissions
        ).toEqual({
            contents: "read"
        });
    });

    it("sends no body for an instance-wide token, as before", () => {
        expect(scoping.installationTokenBody()).toBeUndefined();
    });

    it("refuses anything that is not owner/name", () => {
        for (const bad of ["", "acme", "acme/site/extra", "../x/y", "acme/si te"])
            expect(scoping.repositoryScope(bad, scoping.CLONE_PERMISSIONS)).toBeNull();
    });

    it("answers git in its own format and never with a second line smuggled in", () => {
        expect(scoping.gitCredentialAnswer("ghs_abc")).toBe(
            "username=x-access-token\npassword=ghs_abc\n"
        );
        expect(scoping.gitCredentialAnswer("ghs_abc\nusername=evil")).toBe("");
    });
});

describe("the credential helper", () => {
    /** Runs the helper with a fake curl that prints what it was asked. */
    function helper(action: string): string {
        const dir = mkdtempSync(join(tmpdir(), "polaris-cred-"));
        dirs.push(dir);
        writeFileSync(join(dir, "curl"), '#!/bin/sh\nprintf "curl %s\n" "$*"\n');
        chmodSync(join(dir, "curl"), 0o755);
        const script = join(dir, "helper.sh");
        writeFileSync(
            script,
            gitCredentialScript(
                "https://polaris.example.test/api/agents/sessions/s1/git-credential",
                "tok-1"
            )
        );
        const result = spawnSync("sh", [script.replace(/\\/g, "/"), action], {
            input: "protocol=https\nhost=github.com\n\n",
            encoding: "utf8",
            env: { ...process.env, PATH: `${dir.replace(/\\/g, "/")}:${process.env.PATH}` }
        });
        expect(result.status).toBe(0);
        return result.stdout;
    }

    it("asks Polaris with the session's token on get", () => {
        const said = helper("get");
        expect(said).toContain("/api/agents/sessions/s1/git-credential");
        expect(said).toContain("Authorization: Bearer tok-1");
    });

    it("does nothing for store and erase", () => {
        expect(helper("store")).toBe("");
        expect(helper("erase")).toBe("");
    });
});

describe("the boot script and GitHub", () => {
    it("drops the clone header from the checkout's config and installs the helper", () => {
        const setup = commands.SESSION_SETUP;
        expect(setup).toContain("git config --unset-all http.extraHeader || true");
        expect(setup).toContain(
            'git config credential.helper "!sh \\"$POLARIS_STATE_DIR/git-credential.sh\\""'
        );
        expect(setup.indexOf("--unset-all http.extraHeader")).toBeLessThan(
            setup.indexOf('git checkout -b "$POLARIS_BRANCH"')
        );
    });

    it("hands the agent no GitHub token in its environment", () => {
        expect(commands.SESSION_SETUP).not.toContain("GH_TOKEN");
        expect(commands.SESSION_SETUP).toContain("POLARIS_GIT_CREDENTIAL ");
    });
});
