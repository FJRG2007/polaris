/**
 * What the Servers table offers on a machine that is not answering.
 *
 * A shell and a file browser both need the server to accept an SSH connection,
 * so offering them while the probe says it is down buys nothing but a panel that
 * times out. This pins the two states apart: an answering server keeps its link
 * into Drive, a silent one has both controls disabled.
 *
 * Rendered to static markup - the assertion is about what the row puts on
 * screen, and the heavy children (a terminal, the dialogs) are stubbed because
 * none of them takes part in the decision.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerRow, ServerStatus, ServerStatusPayload } from "../../src/app/(app)/apps/servers/types";

let statuses: ServerStatus[] = [];

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({
        data: { servers: statuses, machineName: "lirio-0" } satisfies ServerStatusPayload,
        loading: false,
        error: null,
        stale: null,
        refreshing: false,
        updatedAt: null,
        refresh: () => {}
    })
}));
vi.mock("../../src/app/(app)/apps/deploy/terminal-panel", () => ({ TerminalPanel: () => null }));
vi.mock("../../src/app/(app)/apps/servers/host-dialog", () => ({ HostDialog: () => null }));
vi.mock("../../src/app/(app)/apps/servers/quick-enroll", () => ({ QuickEnroll: () => null }));
vi.mock("../../src/app/(app)/apps/servers/server-dialog", () => ({ ServerDialog: () => null }));
vi.mock("../../src/app/(app)/apps/servers/server-groups", () => ({ ServerGroups: () => null }));
vi.mock("../../src/app/(app)/apps/servers/remove-server-dialog", () => ({ RemoveServerDialog: () => null }));
vi.mock("../../src/app/(app)/apps/servers/environment-dialog", () => ({ EnvironmentDialog: () => null }));

const { ServersView } = await import("../../src/app/(app)/apps/servers/servers-view");

function server(overrides: Partial<ServerRow> = {}): ServerRow {
    return {
        id: "33333333-3333-4333-8333-333333333333",
        kind: "host",
        name: "lirio-2",
        detail: "polaris",
        os: "Ubuntu 24.04.1 LTS",
        address: "192.168.1.160",
        port: 22,
        authMethod: "key",
        sudo: true,
        hostId: "33333333-3333-4333-8333-333333333333",
        environment: "home-nat",
        wildcardDomain: "",
        suggested: "home-nat",
        confirmed: true,
        ...overrides
    };
}

function render(row: ServerRow, status: ServerStatus): string {
    statuses = [status];
    return renderToStaticMarkup(<ServersView servers={[row]} />);
}

describe("the Servers table on an unreachable machine", () => {
    it("disables the shell and the file browser when it is not answering", () => {
        const row = server();
        const markup = render(row, {
            id: row.id,
            state: "down",
            latencyMs: null,
            detail: "No answer within 3 seconds"
        });

        expect(markup).toContain("No answer");
        expect(markup).not.toContain(`/drive?c=host:${row.hostId}`);
        // Both controls are still on screen - a row that loses its buttons is a
        // row that looks broken - but neither can be pressed.
        expect(markup.match(/disabled=""/g)?.length).toBe(2);
    });

    it("keeps both when the machine answers", () => {
        const row = server();
        const markup = render(row, { id: row.id, state: "up", latencyMs: 12, detail: null });

        expect(markup).toContain(`/drive?c=host:${row.hostId}`);
        expect(markup).not.toContain("disabled=\"\"");
    });

    it("keeps both while the probe has not answered yet", () => {
        const row = server();
        statuses = [];
        const markup = renderToStaticMarkup(<ServersView servers={[row]} />);

        expect(markup).toContain("Checking...");
        expect(markup).toContain(`/drive?c=host:${row.hostId}`);
        expect(markup).not.toContain("disabled=\"\"");
    });
});
