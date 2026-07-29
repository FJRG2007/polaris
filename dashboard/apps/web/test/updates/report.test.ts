/**
 * The bug report for a failed update. It publishes a host's build log to a public
 * tracker, so the two things worth pinning down are what gets stripped out of it
 * and what survives.
 *
 * Over-redacting is its own failure: image digests and layer ids are the most
 * useful lines in a Docker log, and a report with those blanked out is one nobody
 * can act on. And the link has to open the form complete - a URL cut off by the
 * browser opens a half-written issue that reads as the operator's own sloppiness.
 */

import { describe, expect, it } from "vitest";
import { issueBody, issueUrl, redactSecrets, type UpdateReport } from "../../src/lib/update-report";

const REPORT: UpdateReport = {
    build: "70cf790",
    target: "c0886f7",
    edition: "full",
    environment: "home-nat",
    domain: "polaris.example.com",
    kernel: "linux 6.1.0",
    arch: "x64",
    node: "v22.11.0",
    cpus: 4,
    memoryGb: 7.6,
    exitCode: 1,
    log: "Step 16/26 : RUN --mount=type=cache npm ci\nthe --mount option requires BuildKit"
};

describe("what is stripped out", () => {
    it("blanks anything named like a credential", () => {
        const text = redactSecrets(
            "POLARIS_MASTER_KEY=abc123\nPOSTGRES_PASSWORD=hunter2\nGITHUB_TOKEN=ghp_xxx\nAUTH_SECRET=s3cret"
        );

        expect(text).not.toMatch(/abc123|hunter2|ghp_xxx|s3cret/);
        // The names stay: which variable was set is the diagnostic part.
        expect(text).toContain("POLARIS_MASTER_KEY=[redacted]");
        expect(text).toContain("POSTGRES_PASSWORD=[redacted]");
    });

    it("blanks the password in a connection string", () => {
        const text = redactSecrets("postgresql://polaris:hunter2@postgres:5432/polaris");

        expect(text).not.toContain("hunter2");
        expect(text).toContain("postgresql://[redacted]@postgres:5432/polaris");
    });

    it("blanks addresses", () => {
        expect(redactSecrets("contacting someone@example.com now")).toBe("contacting [redacted] now");
    });

    it("leaves the lines that explain the failure alone", () => {
        // Digests and layer ids look random, which is exactly why a blanket rule on
        // random-looking strings would eat them.
        const log =
            " ---> 16e22a550f38\nsha256:9f9027d2e58339a1c0e2b7d4a6f8c1e5b3d7a9f2c4e6b8d0a2c4e6f8a0b2c4d6\n" +
            "Step 16/26 : RUN --mount=type=cache,target=/root/.npm npm ci\n" +
            "the --mount option requires BuildKit";

        expect(redactSecrets(log)).toBe(log);
    });
});

describe("what the report says", () => {
    it("carries the machine's own details, so nobody has to ask for them", () => {
        const body = issueBody(REPORT);

        for (const value of ["70cf790", "c0886f7", "full", "home-nat", "polaris.example.com", "linux 6.1.0", "x64"]) {
            expect(body).toContain(value);
        }
        expect(body).toContain("the --mount option requires BuildKit");
    });

    it("says so plainly when there is no domain", () => {
        expect(issueBody({ ...REPORT, domain: null })).toContain("none configured");
    });

    it("keeps the end of a long log, where a build stops", () => {
        const body = issueBody({ ...REPORT, log: `${"filler line\n".repeat(2000)}the real error` });

        expect(body).toContain("the real error");
        expect(body).toContain("earlier output trimmed");
    });

    it("does not leave an empty code block when the updater wrote nothing", () => {
        expect(issueBody({ ...REPORT, log: "" })).toContain("(the updater wrote no log)");
    });

    it("redacts the log it carries, not only a log passed to redactSecrets", () => {
        expect(issueBody({ ...REPORT, log: "POSTGRES_PASSWORD=hunter2" })).not.toContain("hunter2");
    });
});

describe("the link", () => {
    it("opens the right project's issue form, prefilled", () => {
        const url = new URL(issueUrl("FJRG2007/polaris", REPORT));

        expect(url.origin + url.pathname).toBe("https://github.com/FJRG2007/polaris/issues/new");
        expect(url.searchParams.get("title")).toContain("home-nat");
        expect(url.searchParams.get("body")).toContain("BuildKit");
        expect(url.searchParams.get("labels")).toBe("bug");
    });

    it("fits in an address bar however big the log was", () => {
        const url = issueUrl("FJRG2007/polaris", { ...REPORT, log: "x".repeat(500_000) });

        expect(url.length).toBeLessThanOrEqual(7500);
        // Trimmed, not dropped: the report is still worth filing.
        expect(new URL(url).searchParams.get("body")).toContain("Update log");
    });

    it("builds the link promptly on a log the size a real build produces", () => {
        // Not a micro-benchmark: redaction over a long unbroken token is exactly
        // where a backtracking pattern goes quadratic, and the report is assembled
        // on a machine that has just failed an update. A minute of CPU there reads
        // as the dashboard hanging.
        const log = `${"x".repeat(400_000)}\n${"docker build step\n".repeat(5000)}`;
        const started = process.hrtime.bigint();

        issueUrl("FJRG2007/polaris", { ...REPORT, log });

        expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1000);
    });
});
