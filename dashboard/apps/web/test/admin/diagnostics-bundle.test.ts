/**
 * The support bundle never carries a secret.
 *
 * The environment below is full of them - a database URL with its password, a
 * session secret, access tokens, an AWS-style key pair, a private key, and one
 * credential stored under a name that sounds harmless - and every place a
 * value could leak through is primed to leak it: a check's facts, the recent
 * errors, the safe keys themselves. The archive is then read back byte for byte
 * and none of those values may appear anywhere in it.
 */

import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PEM = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
    "QyNTUxOQAAACBfixtureOnlyNotARealKeyAtAllxxxxxxxxxxxxxxxxxxxxxxxxxxAAAA",
    "-----END OPENSSH PRIVATE KEY-----"
].join("\n");

const SECRETS = {
    dbPassword: "fixture-Db-Passw0rd",
    session: "fixture-session-secret-8f2c1d9e7a",
    github: "ghp_fixtureToken0000000000000000000000",
    awsId: "AKIAFIXTUREEXAMPLE00",
    awsSecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYFIXTUREKEY",
    hidden: "zx9-credential-under-an-innocent-name",
    repoToken: "ghs_fixtureRepoToken000000",
    appUrlPassword: "AppUrlPass99",
    appUrlQuery: "QueryTok3n999"
} as const;

const ENV: Record<string, string> = {
    NODE_ENV: "production",
    PATH: "/usr/local/bin:/usr/bin",
    DATABASE_URL: `postgresql://polaris:${SECRETS.dbPassword}@db:5432/polaris?schema=public`,
    POLARIS_SESSION_SECRET: SECRETS.session,
    BETTER_AUTH_SECRET: SECRETS.session,
    GITHUB_TOKEN: SECRETS.github,
    AWS_ACCESS_KEY_ID: SECRETS.awsId,
    AWS_SECRET_ACCESS_KEY: SECRETS.awsSecret,
    POLARIS_SSH_PRIVATE_KEY: PEM,
    UPSTREAM_X: SECRETS.hidden,
    POLARIS_REPO: `https://x-access-token:${SECRETS.repoToken}@github.com/acme/polaris`,
    POLARIS_APP_URL: `https://admin:${SECRETS.appUrlPassword}@polaris.example.com/path?token=${SECRETS.appUrlQuery}`,
    POLARIS_IMAGE_TAG: "2026.10.1",
    POLARIS_DB_PROVIDER: "postgresql"
};

/** Every string that must not appear, including a private key's body line on its own. */
const FORBIDDEN = [...Object.values(SECRETS), PEM, PEM.split("\n")[1], ENV.DATABASE_URL];

const runDiagnosis = vi.fn(async () => [
    {
        id: "database",
        status: "fail",
        code: "unreachable",
        // A check that wrongly put a value into its facts.
        facts: { detail: `could not connect to ${ENV.DATABASE_URL}`, hidden: SECRETS.hidden },
        fix: null,
        ms: 12
    }
]);
const findMany = vi.fn(async () => [
    {
        title: `Error: auth failed with token ${SECRETS.github} and ${SECRETS.awsSecret}`,
        culprit: `ssh key ${PEM}`,
        level: "error",
        timesSeen: 3,
        firstSeen: new Date("2026-10-01T00:00:00Z"),
        lastSeen: new Date("2026-10-14T00:00:00Z")
    }
]);

vi.mock("@/lib/diagnostics/checks", async (original) => ({
    ...(await original<typeof import("@/lib/diagnostics/checks")>()),
    runDiagnosis
}));
vi.mock("@/lib/diagnostics/speed-test", () => ({ lastSpeedResult: vi.fn(async () => null) }));
vi.mock("@/lib/telemetry/project-service", () => ({
    systemProject: vi.fn(async () => ({ id: "system" }))
}));
vi.mock("@polaris/db", () => ({ prisma: { telemetryIssue: { findMany } } }));

const { bundleFiles, bundleZip, redactConfig, scrubWithheld } = await import(
    "@/lib/diagnostics/support-bundle"
);

async function archiveText(): Promise<string> {
    const zip = await JSZip.loadAsync(await bundleZip(await bundleFiles(ENV)));
    const names = Object.keys(zip.files);
    const contents = await Promise.all(names.map((name) => zip.file(name)!.async("string")));
    return names.map((name, index) => `${name}\n${contents[index]}`).join("\n");
}

describe("the support bundle", () => {
    beforeEach(() => vi.clearAllMocks());

    it("carries none of the secret values anywhere in the archive", async () => {
        const text = await archiveText();
        expect(runDiagnosis).toHaveBeenCalled();
        expect(findMany).toHaveBeenCalled();
        for (const secret of FORBIDDEN) expect(text).not.toContain(secret);
        // Not even as JSON escapes them.
        for (const secret of FORBIDDEN)
            expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
        expect(text).toContain("[redacted]");
    });

    it("holds every file the preview names", async () => {
        const zip = await JSZip.loadAsync(await bundleZip(await bundleFiles(ENV)));
        expect(Object.keys(zip.files).sort()).toEqual(
            [
                "config.json",
                "diagnosis.json",
                "errors.json",
                "manifest.json",
                "speed-test.json"
            ].sort()
        );
        const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
        expect(manifest.imageTag).toBe("2026.10.1");
        expect(manifest.node).toBe(process.version);
    });

    it("reports values only for allowlisted keys, and everything else by name", () => {
        const config = redactConfig(ENV);
        expect(Object.keys(config.values).sort()).toEqual(
            [
                "NODE_ENV",
                "POLARIS_APP_URL",
                "POLARIS_DB_PROVIDER",
                "POLARIS_IMAGE_TAG",
                "POLARIS_REPO"
            ].sort()
        );
        expect(config.values.POLARIS_APP_URL).toBe("https://polaris.example.com");
        expect(config.values.POLARIS_REPO).not.toContain(SECRETS.repoToken);
        expect(config.withheld).toEqual(["POLARIS_SESSION_SECRET", "POLARIS_SSH_PRIVATE_KEY"]);
        const serialised = JSON.stringify(config);
        for (const secret of FORBIDDEN) expect(serialised).not.toContain(secret);
    });

    it("blanks a value whose name gives no hint it is a secret", () => {
        const out = scrubWithheld(`the upstream said ${SECRETS.hidden}`, ENV);
        expect(out).not.toContain(SECRETS.hidden);
    });

    it("leaves the values it publishes on purpose, and the runtime's paths, alone", () => {
        const out = scrubWithheld(
            "NODE_ENV=production on /usr/local/bin:/usr/bin with postgresql",
            ENV
        );
        expect(out).toBe("NODE_ENV=production on /usr/local/bin:/usr/bin with postgresql");
    });
});
