/**
 * Whose context a rewrite carries. The organization is the caller's claim -
 * the mailbox or task space the text is written in - so its guide is read for
 * a member of it only; anybody else gets the rewrite without it. The writer's
 * chosen skills are read from their own skills, enabled ones only. And the
 * route turns a task space into its organization.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
    organization: { findUnique: vi.fn() },
    polarSkill: { findMany: vi.fn() },
    taskSpace: { findUnique: vi.fn() }
}));
const resolveOrgAccess = vi.hoisted(() => vi.fn());
vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/orgs/org-service", () => ({ resolveOrgAccess }));

const { writingProfile } = await import("@/lib/polar/writing-profile");

const user = { id: "u1", name: "Ana", email: "ana@example.test" };

beforeEach(() => {
    vi.clearAllMocks();
    prisma.organization.findUnique.mockResolvedValue({ name: "Acme", writingGuide: "Sign as Acme." });
    prisma.polarSkill.findMany.mockResolvedValue([]);
});

describe("the writer's profile", () => {
    it("carries the organization's guide for a member", async () => {
        resolveOrgAccess.mockResolvedValue({ orgId: "o1" });
        const profile = await writingProfile(user, "o1", null);
        expect(profile.org).toEqual({ name: "Acme", guide: "Sign as Acme." });
        // Membership as the person, never as an instance administrator.
        expect(resolveOrgAccess).toHaveBeenCalledWith({ id: "u1", isAdmin: false }, "o1");
    });

    it("leaves the guide out for somebody who is not a member", async () => {
        resolveOrgAccess.mockResolvedValue(null);
        const profile = await writingProfile(user, "o2", null);
        expect(profile.org).toBeNull();
        expect(prisma.organization.findUnique).not.toHaveBeenCalled();
    });

    it("reads the chosen skills from the writer's own, enabled ones", async () => {
        prisma.polarSkill.findMany.mockResolvedValue([{ name: "Tone", instructions: "Short." }]);
        const profile = await writingProfile(user, null, {
            writingContext: "I lead support.",
            writingSkills: ["Tone", "Gone"]
        });
        expect(prisma.polarSkill.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { ownerId: "u1", name: { in: ["Tone", "Gone"] }, enabled: true }
            })
        );
        expect(profile).toMatchObject({
            writer: { name: "Ana", email: "ana@example.test" },
            org: null,
            context: "I lead support.",
            skills: [{ name: "Tone", instructions: "Short." }]
        });
    });

    it("asks for no skills when none are chosen", async () => {
        await writingProfile(user, null, { writingContext: "", writingSkills: [] });
        expect(prisma.polarSkill.findMany).not.toHaveBeenCalled();
    });
});

describe("the improve route", () => {
    it("uses the organization of the task space the text is written in", async () => {
        vi.resetModules();
        const improveText = vi.fn(async () => ({ text: "Better." }));
        vi.doMock("@/lib/polar/improve-text", () => ({ improveText }));
        vi.doMock("@/lib/polar/access", () => ({
            polarCaller: async () => ({ id: "u1", name: "Ana", email: "ana@example.test" }),
            polarAccessFor: async () => ({ use: true })
        }));
        vi.doMock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
        prisma.taskSpace.findUnique.mockResolvedValue({ orgId: "o9" });
        const { POST } = await import("@/app/api/polar/improve/route");
        const spaceId = "0190a3a0-0000-7000-8000-000000000001";
        const response = await POST(
            new Request("http://x/api/polar/improve", {
                method: "POST",
                body: JSON.stringify({ text: "fix login", purpose: "task", spaceId })
            })
        );
        expect(response.status).toBe(200);
        expect(prisma.taskSpace.findUnique).toHaveBeenCalledWith({
            where: { id: spaceId },
            select: { orgId: true }
        });
        expect(improveText).toHaveBeenCalledWith(
            expect.objectContaining({ id: "u1" }),
            { use: true },
            expect.objectContaining({ orgId: "o9", purpose: "task" })
        );
    });
});
