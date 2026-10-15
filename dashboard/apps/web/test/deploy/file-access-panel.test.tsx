// @vitest-environment jsdom

/**
 * The SFTP accounts list under a service's volumes: the address once a server
 * runs, the add button only for someone who may write the files, and nothing at
 * all for someone who may not read them.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProjectAccessProvider } from "@/app/(app)/apps/deploy/access-context";
import { FileAccessPanel } from "@/app/(app)/apps/deploy/file-access-panel";

vi.mock("@/app/(app)/apps/deploy/file-access-actions", () => ({
    fileAccessAction: async () => ({
        view: {
            accounts: [
                {
                    id: "a1",
                    username: "deploy",
                    readOnly: true,
                    hasPassword: true,
                    hasKey: false,
                    createdAt: "2026-10-01T00:00:00.000Z"
                }
            ],
            folders: ["uploads"],
            server: { host: "192.168.1.10", port: 42222, lastError: null, startedAt: null }
        }
    }),
    createFileAccessAccountAction: vi.fn(),
    deleteFileAccessAccountAction: vi.fn()
}));

afterEach(cleanup);

function renderWith(capabilities: Parameters<typeof ProjectAccessProvider>[0]["capabilities"]) {
    return render(
        <ProjectAccessProvider capabilities={capabilities}>
            <FileAccessPanel applicationId="0190f3a2-7c41-7000-8000-000000000001" />
        </ProjectAccessProvider>,
        { wrapper: MessagesWrapper }
    );
}

describe("FileAccessPanel", () => {
    it("shows the address and the accounts, with add and remove for a writer", async () => {
        renderWith(["project.read", "files.read", "files.write"]);
        expect(await screen.findByText("sftp://192.168.1.10:42222")).toBeTruthy();
        expect(screen.getByText("deploy")).toBeTruthy();
        expect(screen.getByText("Read only")).toBeTruthy();
        expect(screen.getByRole("button", { name: /Add account/ })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Remove deploy" })).toBeTruthy();
    });

    it("draws no add or remove for a reader", async () => {
        renderWith(["project.read", "files.read"]);
        await screen.findByText("deploy");
        expect(screen.queryByRole("button", { name: /Add account/ })).toBeNull();
        expect(screen.queryByRole("button", { name: "Remove deploy" })).toBeNull();
    });

    it("draws nothing for someone who cannot read the files", () => {
        const { container } = renderWith(["project.read"]);
        expect(container.textContent).toBe("");
    });
});
