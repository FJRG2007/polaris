/**
 * The support bundle: one archive with what somebody helping needs to see.
 *
 * Versions, edition, the diagnosis, the dashboard's own recent failures and
 * the configuration - with every value withheld unless its key is on
 * `SAFE_CONFIG_KEYS`. An allowlist rather than a list of things to hide,
 * because the variable added next month is a secret until somebody decides it
 * is not, and a denylist would publish it the day it appeared.
 *
 * Then, over everything, a last pass that blanks the literal value of every
 * withheld variable wherever it turns up - an error message that printed a
 * connection string, a hostname that happens to be a token. The bundle is
 * read as text by people outside the deployment; this is the line that
 * promises none of those values leaves it.
 *
 * Server-only.
 */

import JSZip from "jszip";
import { prisma } from "@polaris/db";
import { buildStamp } from "@/lib/build-stamp";
import { lastSpeedResult } from "./speed-test";
import { runDiagnosis, within } from "./checks";
import { arch, platform, release } from "node:os";
import { getCapabilities } from "@polaris/config";
import { redactSecrets } from "@/lib/update-report";
import { systemProject } from "@/lib/telemetry/project-service";

/**
 * Configuration whose values are safe to hand to a stranger: switches, versions,
 * the engine in use. Anything else is reported only as set or not set. URL keys
 * are cut to their origin, so a userinfo or a query never rides along.
 */
export const SAFE_CONFIG_KEYS: ReadonlySet<string> = new Set([
    "NODE_ENV",
    "POLARIS_AUTO_UPDATE",
    "POLARIS_BUILD_SHA",
    "POLARIS_DB_PROVIDER",
    "POLARIS_IMAGE_TAG",
    "POLARIS_REPO",
    "POLARIS_SECURE_COOKIES",
    "POLARIS_SSH_ENABLED",
    "POLARIS_SSH_PORT",
    "POLARIS_UPDATE_BRANCH",
    "POLARIS_WEB_IMAGE",
    "POLARIS_APP_URL",
    "POLARIS_LOCAL_HOSTNAME"
]);

const URL_KEYS: ReadonlySet<string> = new Set(["POLARIS_APP_URL"]);

/** Which variables are reported at all: Polaris' own and the runtime's mode. */
const REPORTED = /^(POLARIS_|NODE_ENV$)/;
/** Variables outside Polaris' own whose name says they hold a credential -
 *  scrubbed too, since a library's error can print one. Not every variable:
 *  blanking the runtime's version wherever it appears would spoil the manifest. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL|DSN|_URL$/i;
/** Shorter than this, a withheld value is too common a string to scrub by. */
const MIN_SCRUB_LENGTH = 6;
const ERROR_LIMIT = 50;

export interface BundleConfig {
    /** Safe keys, with their values. */
    readonly values: Record<string, string>;
    /** Every other reported key that is set, by name only. */
    readonly withheld: string[];
}

function originOnly(value: string): string {
    try {
        return new URL(value).origin;
    } catch {
        return "[unparseable]";
    }
}

/** The configuration as the bundle carries it. Pure, for the tests. */
export function redactConfig(env: Readonly<Record<string, string | undefined>>): BundleConfig {
    const values: Record<string, string> = {};
    const withheld: string[] = [];
    for (const key of Object.keys(env).sort()) {
        const value = env[key];
        if (!REPORTED.test(key) || value === undefined || value === "") continue;
        if (SAFE_CONFIG_KEYS.has(key)) values[key] = URL_KEYS.has(key) ? originOnly(value) : value;
        else withheld.push(key);
    }
    return { values, withheld };
}

/** Blank every withheld value wherever it appears in `text`. Pure. */
export function scrubWithheld(text: string, env: Readonly<Record<string, string | undefined>>): string {
    const secrets = Object.entries(env)
        .filter(
            ([key, value]) =>
                (REPORTED.test(key) || SECRET_NAME.test(key)) &&
                !SAFE_CONFIG_KEYS.has(key) &&
                value !== undefined &&
                value.length >= MIN_SCRUB_LENGTH
        )
        .map(([, value]) => value as string)
        // Longest first, so a value that contains another is blanked whole.
        .sort((a, b) => b.length - a.length);
    let out = text;
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    // A secret serialised into JSON has its quotes and backslashes escaped.
    for (const secret of secrets) {
        const escaped = JSON.stringify(secret).slice(1, -1);
        if (escaped !== secret) out = out.split(escaped).join("[redacted]");
    }
    return out;
}

async function recentErrors(): Promise<unknown[]> {
    const project = await systemProject();
    if (!project) return [];
    const issues = await prisma.telemetryIssue.findMany({
        where: { projectId: project.id },
        orderBy: { lastSeen: "desc" },
        take: ERROR_LIMIT,
        select: { title: true, culprit: true, level: true, timesSeen: true, firstSeen: true, lastSeen: true }
    });
    return issues.map((issue) => ({
        ...issue,
        title: redactSecrets(issue.title),
        culprit: redactSecrets(issue.culprit)
    }));
}

/** Every file in the bundle, as text, already redacted. */
export async function bundleFiles(
    env: Readonly<Record<string, string | undefined>> = process.env
): Promise<Record<string, string>> {
    const capabilities = getCapabilities();
    const [diagnosis, errors, speed] = await Promise.all([
        runDiagnosis(),
        within(recentErrors(), 5000),
        lastSpeedResult()
    ]);
    const files: Record<string, unknown> = {
        "manifest.json": {
            generatedAt: new Date().toISOString(),
            build: buildStamp(),
            imageTag: env.POLARIS_IMAGE_TAG ?? null,
            edition: capabilities.edition,
            hostAgentVersion: capabilities.hostd.version ?? null,
            capabilities,
            node: process.version,
            platform: platform(),
            kernel: release(),
            arch: arch()
        },
        "diagnosis.json": diagnosis,
        "errors.json": errors ?? { unavailable: true },
        "config.json": redactConfig(env),
        "speed-test.json": speed ?? { notRun: true }
    };
    const out: Record<string, string> = {};
    for (const [name, content] of Object.entries(files))
        out[name] = scrubWithheld(`${JSON.stringify(content, null, 2)}\n`, env);
    return out;
}

/** The archive itself. */
export async function bundleZip(files: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
