// @vitest-environment jsdom

/**
 * The Templates tab of a server: a compliant assignment says so with nothing to
 * fix, a drifted one lists each difference in words with a Fix for the ones
 * Polaris can put back, and a server without root shows why its fixes are off.
 */

import type { AssignmentView, TemplateView } from "@/lib/server-templates/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MessagesWrapper } from "../setup/i18n";

const ID = "8d6c3f1e-2b4a-4c7d-9e0f-1a2b3c4d5e6f";

let assignments: { ok: true; value: AssignmentView[] } | { ok: false; error: string } = { ok: true, value: [] };
let templates: TemplateView[] = [];

vi.mock("../../src/app/(app)/apps/servers/template-actions", () => ({
    hostAssignmentsAction: async () => assignments,
    listTemplatesAction: async () => ({ ok: true, value: templates }),
    assignTemplateAction: async () => ({ ok: false, error: "failed" }),
    checkAssignmentAction: async () => ({ ok: false, error: "failed" }),
    fixAssignmentAction: async () => ({ ok: false, error: "failed" }),
    setAutoFixAction: async () => ({ ok: true, value: undefined }),
    unassignTemplateAction: async () => ({ ok: true, value: undefined })
}));
vi.mock("../../src/app/(app)/apps/servers/[serverId]/templates-dialog", () => ({ TemplatesDialog: () => null }));

const { ServerTemplatesPanel } = await import("../../src/app/(app)/apps/servers/[serverId]/server-templates-panel");

function assignment(patch: Partial<AssignmentView>): AssignmentView {
    return {
        id: ID,
        templateId: ID,
        templateName: "Web server",
        autoFix: false,
        status: "compliant",
        drift: [],
        error: null,
        checkedAt: "2026-10-15T08:00:00.000Z",
        fixedAt: null,
        ...patch
    };
}

const drifted = assignment({
    status: "drifted",
    drift: [
        { key: "pkg:nginx", code: "packageMissing", name: "nginx", fixable: true },
        { key: "sysctl:vm.swappiness", code: "sysctlValue", name: "vm.swappiness", expected: "10", actual: "60", fixable: true },
        { key: "fw:443/tcp", code: "firewallOff", name: "443/tcp", fixable: false }
    ]
});

const show = (root: boolean) => render(<ServerTemplatesPanel hostId={ID} serverName="web-1" root={root} />, { wrapper: MessagesWrapper });

beforeEach(() => {
    templates = [{ id: ID, name: "Web server", description: "", servers: 1, spec: { packages: [], services: [], files: [], sysctl: [], users: [], firewall: [] } }];
});
afterEach(cleanup);

describe("the Templates tab", () => {
    it("says a compliant server is compliant, with nothing to fix", async () => {
        assignments = { ok: true, value: [assignment({})] };
        show(true);
        expect(await screen.findByText("Compliant")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Fix/ })).toBeNull();
        expect(screen.getByRole("button", { name: /Check now/ })).toBeTruthy();
    });

    it("lists each difference in words, with Fix only where Polaris can put it back", async () => {
        assignments = { ok: true, value: [drifted] };
        show(true);
        expect(await screen.findByText("3 differences")).toBeTruthy();
        expect(screen.getByText("Package nginx is not installed")).toBeTruthy();
        expect(screen.getByText("vm.swappiness is 60, expected 10")).toBeTruthy();
        expect(screen.getByText("The firewall is off, so port 443/tcp is not enforced")).toBeTruthy();
        expect(screen.getAllByRole("button", { name: "Fix it" })).toHaveLength(2);
        expect(screen.getByText("Fix by hand")).toBeTruthy();
        const all = screen.getByRole("button", { name: /Fix everything/ }) as HTMLButtonElement;
        expect(all.disabled).toBe(false);
    });

    it("turns the fixes off on a server without root, and says why", async () => {
        assignments = { ok: true, value: [drifted] };
        show(false);
        await screen.findByText("3 differences");
        expect(screen.getByText(/Polaris has no root on this server, so it can check it but not fix it/)).toBeTruthy();
        for (const button of screen.getAllByRole("button", { name: /Fix/ }) as HTMLButtonElement[]) {
            expect(button.disabled).toBe(true);
            expect(button.title).toBe("Polaris has no root on this server, so it cannot fix it.");
        }
        expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    });

    it("shows a refusal in words instead of staying on its skeletons", async () => {
        assignments = { ok: false, error: "unreachable" };
        show(true);
        expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The server did not answer over SSH.");
        await waitFor(() => expect(screen.getByText("No template is assigned to this server.")).toBeTruthy());
    });
});
