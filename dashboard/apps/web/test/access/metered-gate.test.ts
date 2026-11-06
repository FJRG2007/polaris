/**
 * Nothing reaches a service billed per request except through `whileServing`.
 *
 * Two halves. Every function a provider module exports is called repeatedly against
 * a service that refuses for lack of credits, and one request is all it may send:
 * new exports are picked up by themselves. And the ways of reaching those services
 * may appear only in those modules, so a new call cannot go around them.
 */

import { join, relative, sep } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

let settings = new Map<string, string>();
let sent = 0;

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    },
    swapSetting: async (key: string, expected: string | null, value: string) => {
        if ((settings.get(key) ?? null) !== expected) return false;
        settings.set(key, value);
        return true;
    }
}));
vi.mock("@/lib/connections/attention", () => ({
    recordConnectionFailure: async () => true,
    clearConnectionFailure: async () => true
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));

const refused = async (): Promise<never> => {
    sent += 1;
    throw Object.assign(new Error("Insufficient credits"), { response: { status: 402 } });
};

vi.mock("dymo-api", () => ({
    default: class {
        public isValidIP = refused;
        public isValidEmail = refused;
        public isValidDataRaw = refused;
    }
}));

/** Exports that are not requests, or that an operator pressed a button for. */
const NOT_A_REQUEST = new Set([
    "MAIL_DENY_RULES",
    "readIpPlace",
    "VT_MAX_UPLOAD_BYTES",
    "settleIpVerdict",
    "testKey",
    "verifyKey"
]);

const MODULES = {
    dymo: () => import("@/lib/integrations/dymo"),
    virustotal: () => import("@/lib/integrations/virustotal"),
    criminalip: () => import("@/lib/integrations/criminalip")
};

/** Arguments every function takes without complaint: key, subject, then whatever. */
const ARGUMENTS = ["key", "example.test", ["FRAUD"]];

beforeEach(() => {
    settings = new Map();
    sent = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            sent += 1;
            return new Response("{}", { status: 402 });
        })
    );
});

describe.each(Object.keys(MODULES) as (keyof typeof MODULES)[])("%s", (provider) => {
    it("sends one request per function while the account is out of credits", async () => {
        const module = (await MODULES[provider]()) as Record<string, unknown>;
        const requests = Object.entries(module).filter(
            ([name, value]) => typeof value === "function" && !NOT_A_REQUEST.has(name)
        ) as [string, (...args: unknown[]) => Promise<unknown>][];
        expect(requests.length).toBeGreaterThan(0);

        for (const [name, request] of requests) {
            settings = new Map();
            sent = 0;
            for (let pass = 0; pass < 50; pass += 1) {
                await request(...ARGUMENTS).catch(() => undefined);
            }
            expect(sent, name).toBe(1);
        }
    });
});

describe("a VirusTotal scan", () => {
    const answers = (poll: () => Response) =>
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                sent += 1;
                return String(url).endsWith("/files")
                    ? Response.json({ data: { id: "analysis" } })
                    : poll();
            })
        );

    const scan = async () => {
        const { uploadAndScan } = await import("@/lib/integrations/virustotal");
        vi.useFakeTimers();
        const verdict = uploadAndScan("key", new Uint8Array(1), "sha");
        await vi.runAllTimersAsync();
        vi.useRealTimers();
        return verdict;
    };

    beforeEach(async () => {
        const { resetLookupBudget } = await import("@/lib/reputation-budget");
        resetLookupBudget();
    });

    it("stops polling and pauses when a poll is refused", async () => {
        answers(() => new Response("{}", { status: 402 }));
        const verdict = await scan();
        expect(verdict.kind).toBe("error");
        expect(sent).toBe(2);
        expect(settings.get("integration.pause.virustotal")).toContain("credits");
    });

    it("counts every poll against the day", async () => {
        answers(() => Response.json({ data: { attributes: { status: "queued" } } }));
        const verdict = await scan();
        expect(verdict.kind).toBe("unknown");
        const spent = JSON.parse(settings.get("integration.spent.virustotal") ?? "{}") as {
            count: number;
        };
        expect(spent.count).toBe(sent);
        expect(sent).toBeLessThanOrEqual(4);
    });

    it("says the day's requests are gone instead of calling it unreachable", async () => {
        settings.set(
            "integration.spent.virustotal",
            JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 500 })
        );
        const verdict = await scan();
        expect(verdict.detail).toBe("VirusTotal used up today's requests");
        expect(sent).toBe(0);
    });
});

const WEB = join(__dirname, "..", "..");

/** Every source file under a directory. */
function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
            return entry === "node_modules" || entry === ".next" ? [] : sources(path);
        }
        return /\.tsx?$/.test(entry) ? [path] : [];
    });
}

describe("the ways of reaching a metered service", () => {
    it("appear only in the provider modules", () => {
        const roots = [join(WEB, "src"), join(WEB, "..", "..", "packages"), join(WEB, "..")];
        const seen = new Set<string>();
        const offenders: string[] = [];
        for (const root of roots) {
            for (const path of sources(root)) {
                if (seen.has(path) || path.includes(`${sep}test${sep}`)) continue;
                seen.add(path);
                const text = readFileSync(path, "utf8");
                const reaches =
                    /new DymoAPI\(|from "dymo-api"|api\.tpeoficial\.com|virustotal\.com\/api|api\.criminalip\.io|deepl\.com\/v2|translation\.googleapis\.com/.test(
                        text
                    );
                if (reaches) offenders.push(relative(WEB, path).split(sep).join("/"));
            }
        }
        expect(offenders.sort()).toEqual([
            "src/lib/integrations/criminalip.ts",
            "src/lib/integrations/deepl.ts",
            "src/lib/integrations/dymo.ts",
            "src/lib/integrations/google-translate.ts",
            "src/lib/integrations/virustotal.ts"
        ]);
    });
});
