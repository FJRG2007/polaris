/**
 * The owner behind the share dialog's first row: one batched read per subject,
 * nothing for things nobody owns, and the owner's line obeys the privacy rule.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const OWNER = "00000000-0000-4000-8000-0000000000c3";
const CREATOR = "00000000-0000-4000-8000-0000000000d4";

const calls: { model: string; args: { where: { id: { in: string[] } }; select: unknown } }[] = [];
const table = (model: string, rows: Record<string, unknown>[]) => ({
    findMany: async (args: { where: { id: { in: string[] } }; select: unknown }) => {
        calls.push({ model, args });
        return rows.filter((row) => args.where.id.in.includes(row.id as string));
    }
});

vi.mock("@polaris/db", () => ({
    prisma: {
        taskSpace: table("taskSpace", [
            { id: A, ownerId: OWNER },
            { id: B, ownerId: CREATOR }
        ]),
        chatChannel: table("chatChannel", [{ id: A, ownerId: null, createdById: CREATOR }]),
        taskFolder: table("taskFolder", [{ id: A, space: { ownerId: OWNER } }]),
        crmCompany: table("crmCompany", [{ id: A, userId: null, createdById: CREATOR }]),
        crmPerson: table("crmPerson", [{ id: B, userId: OWNER, createdById: CREATOR }]),
        crmOpportunity: table("crmOpportunity", []),
        user: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id === OWNER
                    ? { id: OWNER, name: "", username: "olga", email: "olga@example.test" }
                    : null
        }
    }
}));
vi.mock("@/lib/privacy-service", () => ({
    contactLines: async (_viewer: unknown, people: { id: string; username: string }[]) =>
        new Map(people.map((one) => [one.id, `@${one.username}`]))
}));

const { subjectHasOwner, subjectOwner, subjectOwnerIds } = await import(
    "@/lib/access/subject-owner"
);

beforeEach(() => {
    calls.length = 0;
});

describe("subjectOwnerIds", () => {
    it("reads every id of one subject in a single query", async () => {
        const owners = await subjectOwnerIds("task.space", [A, B, A]);
        expect(owners.get(A)).toBe(OWNER);
        expect(owners.get(B)).toBe(CREATOR);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args.where.id.in).toEqual([A, B]);
    });

    it("falls back to the creator where the owner column is empty", async () => {
        expect((await subjectOwnerIds("chat.channel", [A])).get(A)).toBe(CREATOR);
    });

    it("follows a folder to the space it sits in", async () => {
        expect((await subjectOwnerIds("task.folder", [A])).get(A)).toBe(OWNER);
    });

    it("reads CRM records once per kind, keyed as they were asked", async () => {
        const owners = await subjectOwnerIds("crm.record", [`companies:${A}`, `people:${B}`, "people:bad"]);
        expect(owners.get(`companies:${A}`)).toBe(CREATOR);
        expect(owners.get(`people:${B}`)).toBe(OWNER);
        expect(calls.map((call) => call.model)).toEqual(["crmCompany", "crmPerson"]);
    });

    it("asks nothing for things nobody owns, or for ids that are not ids", async () => {
        expect(subjectHasOwner("place.device")).toBe(false);
        expect(subjectHasOwner("task.space")).toBe(true);
        expect((await subjectOwnerIds("place.device", [A])).size).toBe(0);
        expect((await subjectOwnerIds("task.space", ["not-an-id"])).size).toBe(0);
        expect(calls).toHaveLength(0);
    });
});

describe("subjectOwner", () => {
    const viewer = { id: CREATOR, isAdmin: false };

    it("names the owner with the line the viewer may see", async () => {
        expect(await subjectOwner(viewer, "task.space", A)).toEqual({
            id: OWNER,
            name: "olga",
            contact: "@olga"
        });
    });

    it("is null when the owner's account is gone or there is no owner", async () => {
        expect(await subjectOwner(viewer, "task.space", B)).toBeNull();
        expect(await subjectOwner(viewer, "dns.filter", A)).toBeNull();
    });
});
