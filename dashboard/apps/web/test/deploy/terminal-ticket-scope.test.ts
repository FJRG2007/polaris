/**
 * Who a terminal ticket for a service actually opens a shell on.
 *
 * The route used to take a target id and a container ref straight from the
 * caller and check neither: anybody holding deploy.manage could name any
 * container on the host and get a ticket for it. Now the caller names only the
 * service, the route resolves standing on it through requireApplicationAccess,
 * and the target and container both come from that service's own row - never
 * from the request body.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requirePermission = vi.fn(async () => ({ id: "user-1" }));
const requireApplicationAccess = vi.fn(async () => ({
    ownerId: "owner-1",
    environmentId: "env-1"
}));
const applicationFindUnique = vi.fn();
const currentReleaseRef = vi.fn(async () => ({
    name: "the-real-container",
    project: "polaris-real"
}));
const mintTerminalTicket = vi.fn(async () => "raw-token");

vi.mock("@/lib/session", () => ({
    requireUser: vi.fn(),
    requirePermission: (permission: string) => requirePermission(permission),
    userHasManage: vi.fn(async () => false)
}));

// The route asks the API twin, which answers with a response rather than
// redirecting to a sign-in page - see lib/api-session.
vi.mock("@/lib/api-session", () => ({
    apiUser: vi.fn(),
    apiPermission: (permission: string) => requirePermission(permission),
    apiAdmin: vi.fn()
}));

vi.mock("@/lib/deploy-project-access", () => ({
    requireApplicationAccess: (applicationId: string, userId: string, capability: string) =>
        requireApplicationAccess(applicationId, userId, capability)
}));

vi.mock("@/lib/deploy/releases", () => ({
    currentReleaseRef: (app: unknown) => currentReleaseRef(app)
}));

vi.mock("@/lib/container-service", () => ({ accessFor: vi.fn(() => "docker") }));
vi.mock("@/lib/docker-service", () => ({ resolveDockerTransport: vi.fn() }));
vi.mock("@/lib/terminal-service", () => ({
    canOpenHostShell: vi.fn(async () => false),
    mintTerminalTicket: (userId: string, input: unknown) => mintTerminalTicket(userId, input)
}));

vi.mock("@polaris/db", () => ({
    prisma: { application: { findUnique: applicationFindUnique } }
}));

const { POST } = await import("../../src/app/api/deploy/terminal/ticket/route");

function post(body: Record<string, unknown>): Promise<Response> {
    return POST(
        new NextRequest("http://localhost/api/deploy/terminal/ticket", {
            method: "POST",
            body: JSON.stringify(body)
        })
    );
}

describe("minting a terminal ticket for a service", () => {
    beforeEach(() => {
        requirePermission.mockClear();
        requireApplicationAccess.mockClear();
        applicationFindUnique.mockReset();
        currentReleaseRef.mockClear();
        mintTerminalTicket.mockClear();
        applicationFindUnique.mockResolvedValue({
            id: "app-1",
            slug: "web",
            targetId: "target-1",
            currentDeploymentId: "deploy-1",
            environment: { project: { slug: "acme" } }
        });
    });

    it("requires console.use and ignores any container the caller names", async () => {
        const response = await post({
            applicationId: "app-1",
            containerRef: "some-other-container",
            mode: "terminal"
        });
        expect(response.status).toBe(200);

        expect(requireApplicationAccess).toHaveBeenCalledWith("app-1", "user-1", "console.use");
        // The ticket is minted for the service's own resolved container, never
        // for whatever the request body suggested.
        const [, input] = mintTerminalTicket.mock.calls[0] ?? [];
        expect(input.targetId).toBe("target-1");
        expect(input.containerRef).toBe("the-real-container");
        expect(input.containerRef).not.toBe("some-other-container");
    });

    it("requires logs.read instead when the ticket is for logs", async () => {
        await post({ applicationId: "app-1", mode: "logs" });
        expect(requireApplicationAccess).toHaveBeenCalledWith("app-1", "user-1", "logs.read");
    });

    it("answers service not found rather than minting a ticket when access is refused", async () => {
        requireApplicationAccess.mockRejectedValueOnce(new Error("service not found"));
        const response = await post({ applicationId: "app-1" });
        expect(response.status).toBe(404);
        expect(mintTerminalTicket).not.toHaveBeenCalled();
    });
});
