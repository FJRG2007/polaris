/**
 * A server that is off, in the Containers host list.
 *
 * Opening it would only spend its SSH connect timeout, every five seconds, to fail
 * with a message that names nothing. So it is marked, cannot be opened, and when
 * it is the one selected the page says it is not answering instead of asking it.
 *
 * Rendered to static markup - what is asserted is what the list puts on screen.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DockerConnectionSummary } from "../../src/app/(app)/apps/containers/types";

let reachability: { id: string; state: "up" | "down"; detail: string | null }[] | null = null;
let snapshotRequested: boolean[] = [];

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: (options: { url: string; enabled?: boolean }) => {
        if (options.url.includes("host-status")) {
            return {
                data: reachability,
                loading: false,
                error: null,
                stale: null,
                refresh: () => {}
            };
        }
        snapshotRequested.push(options.enabled !== false);
        return { data: null, loading: true, error: null, stale: null, refresh: () => {} };
    }
}));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => [async () => true, null] }));
vi.mock("../../src/app/(app)/apps/containers/actions", () => ({
    containerAction: async () => ({}),
    removeContainerAction: async () => ({}),
    deleteDockerConnectionAction: async () => undefined
}));
vi.mock("../../src/app/(app)/apps/containers/docker-connection-dialog", () => ({
    DockerConnectionDialog: () => null
}));
vi.mock("../../src/app/(app)/apps/containers/polaris-footprint", () => ({
    PolarisFootprintCard: () => null
}));

const { ContainersView } = await import("../../src/app/(app)/apps/containers/containers-view");

const HOST = "33333333-3333-4333-8333-333333333333";

const connections: DockerConnectionSummary[] = [
    { id: "local", name: "Local host", transport: "socket", status: "active", local: true },
    {
        id: `host:${HOST}`,
        name: "lirio-2",
        transport: "ssh",
        status: "active",
        host: true,
        hostId: HOST
    }
];

function render(selected: string): string {
    return renderToStaticMarkup(
        <ContainersView
            connections={connections}
            connectionId={selected}
            sshEnabled
            canManage
            localDiagnostic={null}
        />
    );
}

beforeEach(() => {
    reachability = null;
    snapshotRequested = [];
});

describe("a server that is not answering", () => {
    it("is marked and cannot be opened", () => {
        reachability = [{ id: HOST, state: "down", detail: "No route to that address" }];
        const markup = render("local");
        expect(markup).toContain("Offline");
        expect(markup).toContain('aria-disabled="true"');
        expect(markup).toContain("Not answering: No route to that address");
        expect(markup).not.toContain(`href="/apps/containers?c=host:${HOST}"`);
        // The local engine is unaffected.
        expect(markup).toContain('href="/apps/containers?c=local"');
    });

    it("is not asked for its containers when it is the one selected", () => {
        reachability = [{ id: HOST, state: "down", detail: "No route to that address" }];
        const markup = render(`host:${HOST}`);
        expect(markup).toContain("lirio-2 is not answering");
        expect(markup).toContain(`/apps/servers/${HOST}`);
        expect(snapshotRequested).toEqual([false]);
    });
});

describe("a server that answers, or has not been checked yet", () => {
    it("opens as before", () => {
        reachability = [{ id: HOST, state: "up", detail: null }];
        const markup = render(`host:${HOST}`);
        expect(markup).toContain(`href="/apps/containers?c=host:${HOST}"`);
        expect(markup).not.toContain("Offline");
        expect(snapshotRequested).toEqual([true]);
    });

    it("is not treated as off while the check is on its way", () => {
        const markup = render(`host:${HOST}`);
        expect(markup).toContain(`href="/apps/containers?c=host:${HOST}"`);
        expect(markup).not.toContain("is not answering");
        expect(snapshotRequested).toEqual([true]);
    });
});
