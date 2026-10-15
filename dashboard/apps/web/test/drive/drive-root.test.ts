import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/effective-access", () => ({ effectiveCan: vi.fn(), effectiveIsAdmin: vi.fn() }));

import { browsesAsRoot } from "@/lib/drive-root";

describe("browsesAsRoot", () => {
    it("reads a server granted sudo as root for an administrator", () => {
        expect(browsesAsRoot({ sudo: true, admin: true, managesServers: true })).toBe(true);
    });

    it("reads it as root for somebody who manages servers without being an administrator", () => {
        expect(browsesAsRoot({ sudo: true, admin: false, managesServers: true })).toBe(true);
    });

    it("keeps the login's view for anybody else", () => {
        expect(browsesAsRoot({ sudo: true, admin: false, managesServers: false })).toBe(false);
    });

    it("never reads as root a server whose enrollment granted no sudo", () => {
        expect(browsesAsRoot({ sudo: false, admin: true, managesServers: true })).toBe(false);
    });
});
