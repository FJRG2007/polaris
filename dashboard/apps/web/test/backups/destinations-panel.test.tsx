/**
 * The destinations panel says when copies share a disk with what they protect,
 * and offers the way out from there: move them to the NAS already connected, or
 * add one when there is none.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DestinationSummary } from "@/app/(app)/apps/backups/types";

vi.mock("@/app/(app)/apps/backups/actions", () => ({
    createDestinationAction: vi.fn(),
    deleteDestinationAction: vi.fn(),
    moveCopiesAction: vi.fn(),
    setDefaultDestinationAction: vi.fn(),
    testDestinationAction: vi.fn()
}));

import { DestinationsPanel } from "@/app/(app)/apps/backups/destinations-panel";

const destination = (extra: Partial<DestinationSummary>): DestinationSummary => ({
    id: "local",
    name: "Polaris data dir",
    kind: "local",
    basePath: "backups",
    isDefault: true,
    status: "active",
    lastError: null,
    lastCheckedAt: null,
    via: null,
    viaKind: null,
    copyCount: 4,
    movableCount: 4,
    usedByPlans: 0,
    storedBytes: 966_000_000,
    ...extra
});

const draw = (destinations: DestinationSummary[], locale: "en-US" | "es-ES" = "en-US") =>
    renderToStaticMarkup(
        withMessages(
            <DestinationsPanel
                destinations={destinations}
                loading={false}
                onChanged={async () => undefined}
            />,
            locale
        )
    );

describe("copies on the data dir", () => {
    it("offers to move them to the NAS that is already a destination", () => {
        const html = draw([
            destination({}),
            destination({
                id: "nas",
                name: "UNAS",
                kind: "connection",
                isDefault: false,
                copyCount: 0,
                movableCount: 0,
                via: "UNAS Pro"
            })
        ]);
        expect(html).toContain("on this server&#x27;s own disk");
        expect(html).toContain("Move them to UNAS");
        expect(html).toContain("Make default");
    });

    it("offers to add one when nothing off the machine exists yet", () => {
        const html = draw([destination({})], "es-ES");
        expect(html).toContain("propio disco de este servidor");
        expect(html).not.toContain("Moverlas a");
    });

    it("says nothing once the default is off the machine", () => {
        const html = draw([
            destination({ isDefault: false }),
            destination({
                id: "nas",
                name: "UNAS",
                kind: "connection",
                isDefault: true,
                copyCount: 4
            })
        ]);
        expect(html).not.toContain("own disk");
    });
});

describe("moving copies", () => {
    it("is offered only for copies that are there whole", () => {
        const html = draw([
            destination({ isDefault: false }),
            destination({
                id: "nas",
                name: "UNAS",
                kind: "connection",
                isDefault: true,
                copyCount: 2,
                movableCount: 0
            })
        ]);
        expect(html.match(/Move copies/g)).toHaveLength(1);
    });
});
