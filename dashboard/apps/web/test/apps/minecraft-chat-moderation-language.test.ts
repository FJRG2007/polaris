/**
 * The warning a stopped player is shown, in their language.
 *
 * What is pinned: a linked player whose account has a language reads it; a
 * linked player whose account never had one reads the server's own, like an
 * unlinked player, rather than the dashboard's English default.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "owner-1";
const SERVER = "00000000-0000-4000-8000-000000000001";
const locales = new Map<string, string>();
const links = new Map<string, string>();

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({ ownerId: OWNER, config: null, applicationId: "app-1" })
        },
        gamePlayerLink: {
            findFirst: async ({ where }: { where: { player: { equals: string } } }) => {
                const userId = links.get(where.player.equals.toLowerCase());
                return userId ? { userId } : null;
            }
        },
        minecraftChatBlock: {
            findFirst: async () => null,
            count: async () => 0,
            create: async () => ({}),
            deleteMany: async () => ({ count: 0 })
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string | null) =>
                raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
            patchInstallConfig: async () => undefined
        },
        envVarService: { listEnvVars: async () => [] },
        rateLimitService: { rateLimit: async () => ({ ok: true }) },
        i18nLocaleService: {
            getUserLocale: async (userId: string) => locales.get(userId) ?? "en-US",
            storedLocale: async (userId: string) => locales.get(userId) ?? null
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/timeout-service", () => ({
    timeoutPlayer: async () => undefined
}));

const { recordBlock } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/chat-moderation-service"
);

function stop(player: string) {
    return recordBlock(
        { installedAppId: SERVER, ownerId: OWNER },
        {
            player,
            reason: "advertising",
            detail: "",
            text: "join example.test",
            command: false,
            at: Date.now()
        }
    );
}

async function warning(player: string): Promise<string> {
    const answer = await stop(player);
    if ("limited" in answer) throw new Error("rate limited");
    return answer.warn;
}

describe("a stopped player's warning", () => {
    beforeEach(() => {
        locales.clear();
        links.clear();
        locales.set(OWNER, "es-ES");
    });

    it("is in the server's language for a linked account with no language of its own", async () => {
        links.set("linked", "user-1");
        const unlinked = await warning("Stranger");
        expect(await warning("Linked")).toBe(unlinked);
        locales.set(OWNER, "en-US");
        expect(await warning("Stranger")).not.toBe(unlinked);
    });

    it("is in the account's language when it has one", async () => {
        links.set("linked", "user-1");
        locales.set("user-1", "en-US");
        const spanish = await warning("Stranger");
        expect(await warning("Linked")).not.toBe(spanish);
    });
});
