/**
 * Signing in the command-line client (`plr login`).
 *
 * What this pins: the secret the CLI polls with is stored only as its hash; an
 * approval is collected exactly once, as an API key of kind "cli"; the key never
 * carries more than the approving account holds; a request that is turned away,
 * expires or belongs to a shut account hands over nothing; and logging out ends
 * only a CLI sign-in, never a key made for something else.
 */

import { hashToken } from "@polaris/core/tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADA = "11111111-1111-4111-8111-111111111111";

interface Row {
    [key: string]: unknown;
}

let authorizations: Row[] = [];
let users: Row[] = [];
let held: string[] = [];
const minted: { userId: string; input: Row; kind?: string }[] = [];
const revoked: { userId: string; id: string }[] = [];

function match(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === "expiresAt" && typeof value === "object" && value !== null) {
            const rule = value as { lt?: Date; gt?: Date };
            const at = row["expiresAt"] as Date;
            if (rule.lt) return at < rule.lt;
            if (rule.gt) return at > rule.gt;
        }
        return row[key] === value;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        cliAuthorization: {
            findUnique: async ({ where }: { where: Row }) =>
                authorizations.find((row) => match(row, where)) ?? null,
            create: async ({ data }: { data: Row }) => {
                if (authorizations.some((row) => row["userCode"] === data["userCode"])) {
                    throw Object.assign(new Error("unique"), { code: "P2002" });
                }
                const made = {
                    id: `a-${authorizations.length + 1}`,
                    createdAt: new Date(),
                    ...data
                };
                authorizations.push(made);
                return made;
            },
            updateMany: async ({ where, data }: { where: Row; data: Row }) => {
                const found = authorizations.filter((row) => match(row, where));
                for (const row of found) Object.assign(row, data);
                return { count: found.length };
            },
            deleteMany: async ({ where }: { where: Row }) => {
                const before = authorizations.length;
                authorizations = authorizations.filter((row) => !match(row, where));
                return { count: before - authorizations.length };
            }
        },
        user: {
            findUnique: async ({ where }: { where: Row }) =>
                users.find((row) => row["id"] === where["id"]) ?? null
        }
    }
}));

vi.mock("@polaris/auth", () => ({
    scopesAvailableTo: async () => held,
    createApiKey: async (userId: string, input: Row, options: { kind?: string } = {}) => {
        minted.push({ userId, input, kind: options.kind });
        return {
            id: `key-${minted.length}`,
            prefix: "plk_abc",
            secret: `plk_abc.secret-${minted.length}`
        };
    },
    revokeApiKey: async (userId: string, id: string) => void revoked.push({ userId, id })
}));

const { answerCliSignIn, claimCliSignIn, cliOs, describeCliSignIn, endCliSignIn, openCliSignIn } =
    await import("@/lib/cli/sign-in");

const fixedRandom = (size: number) => new Uint8Array(size).fill(3);

const REQUEST = {
    deviceName: "ada-laptop",
    clientVersion: "0.4.6",
    scopes: ["deploy.read", "deploy.manage"] as const,
    requestIp: "203.0.113.4",
    requestUserAgent: "polaris-cli/0.4.6 (darwin; arm64; node 22.11.0)",
    requestHost: "polaris.example"
};

beforeEach(() => {
    authorizations = [];
    users = [
        {
            id: ADA,
            name: "Ada",
            email: "ada@example.com",
            bannedAt: null,
            disabledAt: null,
            isAdmin: false
        }
    ];
    held = ["deploy.read", "deploy.manage", "drive.read"];
    minted.length = 0;
    revoked.length = 0;
});

describe("opening a request", () => {
    it("keeps only the hash of the CLI's secret and hands back a short code", async () => {
        const opened = await openCliSignIn(REQUEST, fixedRandom);
        expect(opened?.userCode).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ2-9]{8}$/);
        const row = authorizations[0]!;
        expect(row["codeHash"]).toBe(hashToken(opened!.deviceCode));
        expect(JSON.stringify(row)).not.toContain(opened!.deviceCode);
        expect(row["status"]).toBe("pending");
    });

    it("describes it to the person deciding, with the system the CLI runs on", async () => {
        const opened = await openCliSignIn(REQUEST, fixedRandom);
        const pending = await describeCliSignIn(opened!.userCode);
        expect(pending).toMatchObject({
            device: "ada-laptop",
            os: "macOS",
            clientVersion: "0.4.6",
            scopes: ["deploy.read", "deploy.manage"],
            requestIp: "203.0.113.4"
        });
    });

    it("draws another code when the first is taken", async () => {
        const first = await openCliSignIn(REQUEST, fixedRandom);
        let calls = 0;
        const second = await openCliSignIn(REQUEST, (size) =>
            new Uint8Array(size).fill(calls++ === 0 ? 3 : 4)
        );
        expect(second?.userCode).not.toBe(first?.userCode);
    });
});

describe("collecting it", () => {
    it("waits while nobody has answered", async () => {
        const opened = await openCliSignIn(REQUEST, fixedRandom);
        expect(await claimCliSignIn(opened!.deviceCode)).toEqual({ status: "pending" });
    });

    it("hands over a CLI key exactly once after approval", async () => {
        const opened = await openCliSignIn(REQUEST, fixedRandom);
        expect(
            await answerCliSignIn({ userId: ADA, userCode: opened!.userCode, approve: true })
        ).toBe(true);

        const claimed = await claimCliSignIn(opened!.deviceCode);
        expect(claimed).toMatchObject({
            status: "approved",
            token: "plk_abc.secret-1",
            keyId: "key-1",
            scopes: ["deploy.read", "deploy.manage"],
            account: { id: ADA, email: "ada@example.com" }
        });
        expect(minted[0]).toMatchObject({ userId: ADA, kind: "cli" });
        expect(minted[0]!.input).toMatchObject({
            name: "CLI - ada-laptop",
            scopes: ["deploy.read", "deploy.manage"],
            expiresInDays: 365
        });

        // Spent: a second poll gets nothing.
        expect(await claimCliSignIn(opened!.deviceCode)).toEqual({ status: "expired" });
        expect(minted).toHaveLength(1);
    });

    it("never carries more than the approving account holds", async () => {
        held = ["deploy.read"];
        const opened = await openCliSignIn(REQUEST, fixedRandom);
        await answerCliSignIn({ userId: ADA, userCode: opened!.userCode, approve: true });
        const claimed = await claimCliSignIn(opened!.deviceCode);
        expect(claimed).toMatchObject({ status: "approved", scopes: ["deploy.read"] });
    });

    it("hands over nothing to an account that holds none of what was asked", async () => {
        held = ["drive.read"];
        const opened = await openCliSignIn(REQUEST, fixedRandom);
        await answerCliSignIn({ userId: ADA, userCode: opened!.userCode, approve: true });
        expect(await claimCliSignIn(opened!.deviceCode)).toEqual({ status: "denied" });
        expect(minted).toHaveLength(0);
    });

    it("hands over nothing once turned away", async () => {
        const opened = await openCliSignIn(REQUEST, fixedRandom);
        await answerCliSignIn({ userId: ADA, userCode: opened!.userCode, approve: false });
        expect(await claimCliSignIn(opened!.deviceCode)).toEqual({ status: "denied" });
        expect(authorizations).toHaveLength(0);
        expect(minted).toHaveLength(0);
    });

    it("hands over nothing to an account shut after it approved", async () => {
        const opened = await openCliSignIn(REQUEST, fixedRandom);
        await answerCliSignIn({ userId: ADA, userCode: opened!.userCode, approve: true });
        users[0]!["bannedAt"] = new Date();
        expect(await claimCliSignIn(opened!.deviceCode)).toEqual({ status: "denied" });
        expect(minted).toHaveLength(0);
    });

    it("expires, and an expired code can neither be described nor answered", async () => {
        const start = new Date("2026-10-04T10:00:00Z");
        const opened = await openCliSignIn(REQUEST, fixedRandom, start);
        const later = new Date(start.getTime() + 6 * 60_000);
        expect(await describeCliSignIn(opened!.userCode, later)).toBeNull();
        expect(await claimCliSignIn(opened!.deviceCode, later)).toEqual({ status: "expired" });
        expect(
            await answerCliSignIn({ userId: ADA, userCode: opened!.userCode, approve: true })
        ).toBe(false);
    });

    it("answers an unknown secret as expired, like any other dead code", async () => {
        expect(await claimCliSignIn("not-a-code-anyone-was-given")).toEqual({ status: "expired" });
    });
});

describe("signing out", () => {
    it("revokes a CLI key", async () => {
        expect(await endCliSignIn({ keyId: "key-1", userId: ADA, kind: "cli" })).toBe(true);
        expect(revoked).toEqual([{ userId: ADA, id: "key-1" }]);
    });

    it("leaves a key made for something else alone", async () => {
        expect(await endCliSignIn({ keyId: "key-2", userId: ADA, kind: "key" })).toBe(false);
        expect(revoked).toEqual([]);
    });
});

it("names the system from the CLI's user-agent, and from a browser's otherwise", () => {
    expect(cliOs("polaris-cli/0.4.6 (win32; x64; node 22.0.0)")).toBe("Windows");
    expect(cliOs("polaris-cli/0.4.6 (linux; arm64; node 22.0.0)")).toBe("Linux");
    expect(cliOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macOS");
});
