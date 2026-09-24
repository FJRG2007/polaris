/**
 * Typing a Minecraft username instead of proving it.
 *
 * Most deployments have no Microsoft application approved for the Minecraft API,
 * so without this the Minecraft card offered nothing at all. What has to hold:
 * the form and the action judge a name by the same schema, the action stores what
 * that schema produced and nothing it did not, and the card offers the typed name
 * whether or not the verified link is available - while saying which of the two
 * a linked name is.
 */

import { minecraftNameSchema } from "@polaris/core";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saved: { userId: string; provider: string; label: string }[] = [];

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "ana", isAdmin: false }) }));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/github-service", () => ({ readGithubAccount: async () => ({}) }));
vi.mock("@/lib/integrations/aws-api", () => ({ awsIdentity: async () => ({}) }));
vi.mock("@/lib/integrations/vercel-api", () => ({ vercelUser: async () => ({}) }));
vi.mock("@/lib/integrations/railway-api", () => ({ railwayAccount: async () => ({}) }));
vi.mock("@/lib/connections/store", () => {
    class ConnectionClaimedError extends Error {}
    class ConnectionLimitError extends Error {}
    class ConnectionVerifiedError extends Error {}
    return {
        ConnectionClaimedError,
        ConnectionLimitError,
        ConnectionVerifiedError,
        deleteConnection: async () => null,
        saveConnection: async () => ({}),
        saveTypedConnection: async (userId: string, provider: string, label: string) => {
            if (label === "Taken_By_Proof") throw new ConnectionVerifiedError("Disconnect it first");
            saved.push({ userId, provider, label });
            return { id: "row-1", provider, label, method: "manual" };
        }
    };
});

const { saveMinecraftNameAction } = await import("../../src/app/(app)/account/connections/actions");
const { ConnectionsView } = await import("../../src/app/(app)/account/connections/connections-view");

type Card = Parameters<typeof ConnectionsView>[0]["providers"][number];

beforeEach(() => {
    saved.length = 0;
});

describe("the username schema both sides share", () => {
    it("accepts a Java username and trims it, keeping its case", () => {
        expect(minecraftNameSchema.parse("  Steve_01 ")).toBe("Steve_01");
        expect(minecraftNameSchema.parse("abc")).toBe("abc");
        expect(minecraftNameSchema.parse("A".repeat(16))).toBe("A".repeat(16));
    });

    it("refuses what Mojang does not allow", () => {
        for (const bad of ["ab", "A".repeat(17), "bad-name", "with space", "ñandú", "  "]) {
            expect(minecraftNameSchema.safeParse(bad).success).toBe(false);
        }
    });

    it("says what an acceptable name looks like", () => {
        const result = minecraftNameSchema.safeParse("no!");
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toBe("3 to 16 letters, numbers or underscores");
    });
});

describe("saving a typed name", () => {
    it("stores the trimmed name as the caller's own Minecraft link", async () => {
        expect(await saveMinecraftNameAction("  Ana_MC ")).toEqual({ name: "Ana_MC" });
        expect(saved).toEqual([{ userId: "ana", provider: "minecraft", label: "Ana_MC" }]);
    });

    it("refuses an invalid name before anything is stored", async () => {
        const result = await saveMinecraftNameAction("x");
        expect(result.error).toBe("3 to 16 letters, numbers or underscores");
        expect(await saveMinecraftNameAction({ name: "Ana_MC" })).toHaveProperty("error");
        expect(saved).toHaveLength(0);
    });

    it("passes on why a verified account keeps its place", async () => {
        expect(await saveMinecraftNameAction("Taken_By_Proof")).toEqual({ error: "Disconnect it first" });
    });
});

/** The Minecraft card as the screen builds it. */
function minecraft(overrides: Partial<Card> = {}, accounts: Card["accounts"] = []): Card {
    return {
        slug: "minecraft",
        name: "Minecraft",
        category: "general",
        summary: "Be added to a Minecraft server by name.",
        description: "A Minecraft server lets people in by username.",
        acceptsToken: false,
        acceptsTypedName: true,
        requires: "a Microsoft application approved for the Minecraft API",
        limit: 1,
        canAuthorize: false,
        canSignIn: false,
        accounts,
        ...overrides
    };
}

function account(method: "oauth" | "manual", label: string): Card["accounts"][number] {
    return {
        id: `link-${method}`,
        provider: "minecraft",
        label,
        avatarUrl: null,
        method,
        signsIn: false,
        linkedAt: new Date("2026-09-01T10:00:00.000Z").toISOString()
    };
}

const markup = (card: Card): string => renderToStaticMarkup(<ConnectionsView providers={[card]} />);

describe("the Minecraft card", () => {
    it("offers a typed name where the Microsoft application is not connected", () => {
        const html = markup(minecraft());
        expect(html).toContain("Type your username");
        expect(html).not.toContain("Connect Minecraft");
        expect(html).not.toContain("Available once");
    });

    it("offers it beside the verified link where that one is available", () => {
        const html = markup(minecraft({ canAuthorize: true }));
        expect(html).toContain("Connect Minecraft");
        expect(html).toContain("Type your username");
    });

    it("marks a typed name as not verified and lets it be changed", () => {
        const html = markup(minecraft({ canAuthorize: true }, [account("manual", "Ana_MC")]));
        expect(html).toContain("Not verified");
        expect(html).toContain("Change Ana_MC");
        expect(html).not.toContain("Type your username");
        // Connecting the real account is still open: the typed name holds no slot.
        expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Connect Minecraft/);
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Connect Minecraft/);
    });

    it("marks a proved account as verified and offers no typed name over it", () => {
        const html = markup(minecraft({ canAuthorize: true }, [account("oauth", "Notch")]));
        expect(html).toContain("Verified");
        expect(html).not.toContain("Not verified");
        expect(html).not.toContain("Type your username");
        expect(html).not.toContain("Change Notch");
        // The one slot is spent on the proved account, so Connect is shut here.
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Connect Minecraft/);
    });

    it("says nothing about verification on a card that takes no typed name", () => {
        const html = markup(
            minecraft({ slug: "steam", name: "Steam", acceptsTypedName: false, canAuthorize: true }, [
                { ...account("oauth", "paulinho"), provider: "steam" }
            ])
        );
        expect(html).not.toContain("Verified");
        expect(html).not.toContain("Type your username");
    });
});
