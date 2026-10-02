/**
 * The Servers app, drawn in Spanish.
 *
 * The table is the screen every server passes through; the rest is what a
 * migration misses - where a server lives (words the domain wizard shares), and
 * a refusal the enrolling machine sent back in English and that is stored that
 * way.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import { renderToStaticMarkup } from "react-dom/server";
import { ENROLLMENT_REFUSAL_MESSAGES } from "@polaris/core";
import { environmentWords } from "@/app/(app)/apps/servers/environment-meta";
import type { ServerRow, ServerStatusPayload } from "@/app/(app)/apps/servers/types";
import { enrollmentRefusalText } from "@/app/(app)/apps/servers/enrollment-refusal-text";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({
        data: { servers: [], machineName: "node-0" } satisfies ServerStatusPayload,
        loading: false,
        error: null,
        stale: null,
        refreshing: false,
        updatedAt: null,
        refresh: () => {}
    })
}));
vi.mock("@/app/(app)/apps/servers/actions", () => ({ renameServerAction: async () => ({}) }));
vi.mock("@/app/(app)/apps/deploy/terminal-panel", () => ({ TerminalPanel: () => null }));
vi.mock("@/app/(app)/apps/servers/quick-enroll", () => ({ QuickEnroll: () => null }));
vi.mock("@/app/(app)/apps/servers/server-groups", () => ({ ServerGroups: () => null }));
vi.mock("@/app/(app)/apps/servers/remove-server-dialog", () => ({ RemoveServerDialog: () => null }));
vi.mock("@/app/(app)/apps/servers/environment-dialog", () => ({ EnvironmentDialog: () => null }));

const { ServersView } = await import("@/app/(app)/apps/servers/servers-view");

const row: ServerRow = {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "host",
    name: "node-2",
    detail: "polaris",
    os: "Ubuntu 24.04.1 LTS",
    address: "10.0.1.160",
    port: 22,
    authMethod: "key",
    sudo: true,
    hostId: "33333333-3333-4333-8333-333333333333",
    environment: "unknown",
    wildcardDomain: "",
    suggested: "home-nat",
    confirmed: false
};

describe("the Servers table", () => {
    it("is drawn in Spanish, with a server whose place is not set yet", () => {
        const markup = renderToStaticMarkup(
            withMessages(<ServersView servers={[row]} machineName="node-0" />, "es-ES")
        );
        expect(markup).toContain("Servidores");
        expect(markup).toContain("Ubicación");
        expect(markup).toContain("Fijar ubicación");
        expect(markup).toContain("Añadir servidor");
        expect(markup).toContain("Indica dónde está <b");
        expect(markup).not.toContain("Set location");
    });
});

describe("where a server lives", () => {
    it("reads in Spanish wherever the choice is offered", () => {
        const t = translatorFor("es-ES", "components");
        expect(environmentWords(t, "home-nat").label).toBe("Red de casa u oficina");
        expect(environmentWords(t, "home-cgnat").routing).toContain("túnel");
    });
});

describe("a machine that refused to enroll", () => {
    it("says why in Spanish, from the English sentence it was stored with", () => {
        const t = translatorFor("es-ES", "servers");
        expect(enrollmentRefusalText(t, ENROLLMENT_REFUSAL_MESSAGES["not-root"])).toBe(
            "La máquina se detuvo antes de registrarse: el comando no se ejecutó como root. Ejecútalo con sudo."
        );
        expect(enrollmentRefusalText(t, ENROLLMENT_REFUSAL_MESSAGES["no-home-directory"])).toContain("'polaris'");
    });

    it("keeps English readers' sentence exactly as it was", () => {
        const t = translatorFor("en-US", "servers");
        for (const english of Object.values(ENROLLMENT_REFUSAL_MESSAGES)) {
            expect(enrollmentRefusalText(t, english)).toBe(english);
        }
        expect(enrollmentRefusalText(t, "Something else entirely")).toBe("Something else entirely");
    });
});
