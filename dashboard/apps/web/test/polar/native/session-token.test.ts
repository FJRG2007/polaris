// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "@polaris/core/tokens";

const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findUnique: async ({ where }: { where: { tokenHash: string } }) => rows.get(where.tokenHash) ?? null
        }
    }
}));

const { nativeSessionForToken } = await import("@/lib/agents/session-service");

const add = (token: string, row: Record<string, unknown>) => rows.set(hashToken(token), row);

describe("nativeSessionForToken", () => {
    beforeEach(() => rows.clear());

    it("answers a live native session with the person who started it", async () => {
        add("t-native", { id: "s1", state: "working", cli: "polaris-native", startedById: "u1" });
        expect(await nativeSessionForToken("t-native")).toEqual({ id: "s1", userId: "u1" });
    });

    it("never lets a CLI session's token call models", async () => {
        add("t-cli", { id: "s2", state: "working", cli: "opencode", startedById: "u1" });
        expect(await nativeSessionForToken("t-cli")).toBeNull();
    });

    it("refuses a finished session, one with no starter, an unknown token and none", async () => {
        add("t-over", { id: "s3", state: "stopped", cli: "polaris-native", startedById: "u1" });
        add("t-orphan", { id: "s4", state: "working", cli: "polaris-native", startedById: null });
        expect(await nativeSessionForToken("t-over")).toBeNull();
        expect(await nativeSessionForToken("t-orphan")).toBeNull();
        expect(await nativeSessionForToken("t-unknown")).toBeNull();
        expect(await nativeSessionForToken("")).toBeNull();
    });
});
