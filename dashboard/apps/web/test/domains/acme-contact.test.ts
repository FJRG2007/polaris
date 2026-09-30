/**
 * The certificate contact address: which one the edge is given, and what the edge
 * does with it when it starts.
 *
 * It used to be a line in `.env` that a screen told the operator to edit, and its
 * default - admin@example.com - is an address Let's Encrypt refuses, so an install
 * nobody typed an address into registered no account and was issued no certificate.
 * What is pinned here is that a reserved address is never handed on, that the one
 * chosen on the screen wins over the installer's, and that the edge's own start-up
 * applies the same rule to the file the dashboard writes.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
    acmeEdgeState,
    acmeEmailProblem,
    isUsableAcmeEmail,
    normalizeAcmeEmail,
    resolveAcmeEmail
} from "@/lib/tls/acme-contact";

describe("which addresses can be given to the certificate authority", () => {
    it("takes a real mailbox, in one form", () => {
        expect(normalizeAcmeEmail("  Ops@Corp.IO ")).toBe("ops@corp.io");
        expect(isUsableAcmeEmail("ops@corp.io")).toBe(true);
        expect(acmeEmailProblem(" Ops@Corp.IO ")).toBeNull();
    });

    it("takes no address at all, which Let's Encrypt accepts", () => {
        expect(acmeEmailProblem("")).toBeNull();
        expect(acmeEmailProblem("   ")).toBeNull();
    });

    it("refuses the reserved domains Let's Encrypt refuses, the old default among them", () => {
        for (const address of ["admin@example.com", "a@mail.example.org", "a@box.test", "a@polaris.local", "a@x.invalid"]) {
            expect(isUsableAcmeEmail(address)).toBe(false);
            expect(acmeEmailProblem(address)).toBe("reserved");
        }
    });

    it("refuses what is not an address, and anything a command line would read", () => {
        for (const address of ["not-an-address", "a@b", "a b@corp.io", "a@corp.io; rm -rf /", "$(id)@corp.io"]) {
            expect(acmeEmailProblem(address)).toBe("invalid");
        }
    });
});

describe("which address is in use", () => {
    it("is the one chosen on the screen over the installer's", () => {
        expect(resolveAcmeEmail("me@mail.co", "ops@corp.io")).toEqual({ email: "me@mail.co", source: "setting" });
    });

    it("keeps a chosen empty address as the choice of none", () => {
        expect(resolveAcmeEmail("", "ops@corp.io")).toEqual({ email: "", source: "setting" });
    });

    it("falls back to the installer's, and never passes on a reserved one", () => {
        expect(resolveAcmeEmail(null, "Ops@Corp.io")).toEqual({ email: "ops@corp.io", source: "install" });
        expect(resolveAcmeEmail(null, "admin@example.com")).toEqual({ email: "", source: "none" });
        expect(resolveAcmeEmail(null, undefined)).toEqual({ email: "", source: "none" });
    });
});

describe("whether the edge is running with it", () => {
    it("is current when the edge started after the address was written", () => {
        expect(acmeEdgeState({ startedAt: 2_000, readsFile: true, writtenAt: 1_000 })).toBe("current");
        expect(acmeEdgeState({ startedAt: 2_000, readsFile: true, writtenAt: null })).toBe("current");
    });

    it("is pending when the address was written after the edge started", () => {
        expect(acmeEdgeState({ startedAt: 1_000, readsFile: true, writtenAt: 2_000 })).toBe("pending");
    });

    it("is outdated when the running edge predates the start-up that reads it", () => {
        expect(acmeEdgeState({ startedAt: 1_000, readsFile: false, writtenAt: 2_000 })).toBe("outdated");
    });

    it("is unknown when this machine will not say", () => {
        expect(acmeEdgeState({ startedAt: null, readsFile: false, writtenAt: 2_000 })).toBe("unknown");
    });
});

/** The edge's start-up, as compose hands it to the shell. */
function edgePrelude(): string {
    const compose = readFileSync(new URL("../../../../docker/docker-compose.yml", import.meta.url), "utf8");
    const service = compose.slice(compose.indexOf("\n  traefik:"));
    const start = service.indexOf("      - >-\n") + "      - >-\n".length;
    const end = service.indexOf("\n      - --", start);
    // A folded scalar: one line, joined by spaces. `$$` is compose's escape for `$`.
    return service
        .slice(start, end)
        .split("\n")
        .map((line) => line.trim())
        .join(" ")
        .replaceAll("$$", "$");
}

/** Run the start-up with the real entrypoint replaced by a printer of its arguments. */
function startEdge(dir: string, env: Record<string, string>): string[] {
    const script = edgePrelude()
        .replaceAll("/dynamic/acme-email", join(dir, "acme-email").replaceAll("\\", "/"))
        .replaceAll("/var/log/traefik", join(dir, "log").replaceAll("\\", "/"))
        .replace("/entrypoint.sh", 'printf "%s\\n"');
    const run = spawnSync("sh", ["-c", script, "--", "--providers.docker=true"], {
        env: { PATH: process.env.PATH ?? "", ...env },
        encoding: "utf8"
    });
    expect(run.status).toBe(0);
    return run.stdout.split("\n").filter(Boolean);
}

const FLAG = "--certificatesresolvers.letsencrypt.acme.email=";

describe("the edge's start-up", () => {
    it("reads the address from the file the dashboard writes, over the installer's", () => {
        const dir = mkdtempSync(join(tmpdir(), "acme-"));
        try {
            expect(startEdge(dir, { POLARIS_ACME_EMAIL: "ops@corp.io" })).toEqual([
                "--providers.docker=true",
                `${FLAG}ops@corp.io`
            ]);
            writeFileSync(join(dir, "acme-email"), "me@mail.co\n");
            expect(startEdge(dir, { POLARIS_ACME_EMAIL: "ops@corp.io" })).toContain(`${FLAG}me@mail.co`);
            // An empty file is the choice of none: no flag, not the installer's.
            writeFileSync(join(dir, "acme-email"), "\n");
            expect(startEdge(dir, { POLARIS_ACME_EMAIL: "ops@corp.io" })).toEqual(["--providers.docker=true"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("passes a reserved or malformed address as none rather than have the account refused", () => {
        const dir = mkdtempSync(join(tmpdir(), "acme-"));
        try {
            expect(startEdge(dir, { POLARIS_ACME_EMAIL: "admin@example.com" })).toEqual(["--providers.docker=true"]);
            expect(startEdge(dir, {})).toEqual(["--providers.docker=true"]);
            writeFileSync(join(dir, "acme-email"), "a b@corp.io; touch pwned\n");
            expect(startEdge(dir, {})).toEqual(["--providers.docker=true"]);
            writeFileSync(join(dir, "acme-email"), "x@sub.test\n");
            expect(startEdge(dir, {})).toEqual(["--providers.docker=true"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("no longer carries a default address on its command line", () => {
        const compose = readFileSync(new URL("../../../../docker/docker-compose.yml", import.meta.url), "utf8");
        expect(compose).not.toContain("acme.email=${POLARIS_ACME_EMAIL");
    });
});
