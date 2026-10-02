/**
 * The Containers app, in Spanish.
 *
 * The host list and a server that is off are what somebody sees first; the
 * state badges are the engine's own words, shown through the catalog.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import { renderToStaticMarkup } from "react-dom/server";
import type { DockerConnectionSummary } from "@/app/(app)/apps/containers/types";
import { containerStateLabel } from "@/app/(app)/apps/containers/container-words";

const HOST = "33333333-3333-4333-8333-333333333333";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: (options: { url: string }) =>
        options.url.includes("host-status")
            ? { data: [{ id: HOST, state: "down", detail: null }], loading: false, error: null, stale: null, refresh: () => {} }
            : { data: null, loading: true, error: null, stale: null, refresh: () => {} }
}));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => [async () => true, null] }));
vi.mock("@/app/(app)/apps/containers/actions", () => ({
    containerAction: async () => ({}),
    removeContainerAction: async () => ({}),
    deleteDockerConnectionAction: async () => undefined
}));
vi.mock("@/app/(app)/apps/containers/docker-connection-dialog", () => ({ DockerConnectionDialog: () => null }));
vi.mock("@/app/(app)/apps/containers/polaris-footprint", () => ({ PolarisFootprintCard: () => null }));

const { ContainersView } = await import("@/app/(app)/apps/containers/containers-view");

const connections: DockerConnectionSummary[] = [
    { id: "local", name: "Local host", transport: "socket", status: "active", local: true },
    { id: `host:${HOST}`, name: "node-2", transport: "ssh", status: "active", host: true, hostId: HOST }
];

describe("the host list", () => {
    it("says a server is off, and why it cannot be opened, in Spanish", () => {
        const markup = renderToStaticMarkup(
            withMessages(
                <ContainersView
                    connections={connections}
                    connectionId={`host:${HOST}`}
                    sshEnabled
                    canManage
                    localDiagnostic={null}
                />,
                "es-ES"
            )
        );
        expect(markup).toContain("Hosts de Docker");
        expect(markup).toContain("Apagado");
        expect(markup).toContain("node-2 no responde");
        expect(markup).toContain("su página de servidor");
        expect(markup).not.toContain("Offline");
    });
});

describe("a container's state", () => {
    it("reads in Spanish, and a state it does not know as the engine said it", () => {
        const t = translatorFor("es-ES", "containers");
        expect(containerStateLabel(t, "exited")).toBe("detenido");
        expect(containerStateLabel(t, "hibernating")).toBe("hibernating");
        expect(containerStateLabel(translatorFor("en-US", "containers"), "running")).toBe("running");
    });
});
