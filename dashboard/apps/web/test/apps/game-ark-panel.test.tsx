/**
 * What an ARK server's page shows before the server has said anything.
 *
 * Asking an ARK server who is on it is a command inside its container, and a
 * server loading a map does not answer for minutes. Everything else on the page -
 * the address, the list of who may join, the schedule - is a row Polaris already
 * has, so none of it may wait on that read. It used to: the whole panel arrived
 * from one poll, so the players table sat empty behind a server that was still
 * starting, and forever behind one that never answers.
 *
 * The second half of that bargain is what the table may claim in the meantime.
 * A name with a grey "Offline" beside it is a statement about the server, and
 * before the first read there is nothing to base it on.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GameContext } from "@/app/(app)/apps/installed/[id]/game-context";

const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";

// The panel reaches its neighbours' modules, and one of those reads Polaris'
// configuration as it is imported. A running server has all of this; a test
// process has to say so.
vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

vi.mock("next/navigation", () => ({
    usePathname: () => `/apps/installed/${INSTALL}/players`,
    useRouter: () => ({ refresh: () => undefined, push: () => undefined })
}));

// Server actions, which the panel only calls from an event handler. Rendering it
// must not drag the database and the session into the test.
vi.mock("@/app/(app)/apps/installed/[id]/ark-actions", () => ({}));
vi.mock("@/app/(app)/apps/installed/[id]/minecraft-actions", () => ({}));
vi.mock("@/app/(app)/apps/installed/[id]/access-actions", () => ({}));

const { ArkPanel } = await import("@/app/(app)/apps/installed/[id]/ark-panel");

/** A server with two people on its allow list and nothing known about it live. */
function context(overrides: Partial<GameContext> = {}): GameContext {
    return {
        hostname: "los-payasos-gaming",
        suffix: "ark.example.com",
        address: "los-payasos-gaming.ark.example.com:19133",
        iconSetAt: null,
        schedule: { enabled: false, timezone: "UTC", otherwise: "on", idleMinutes: 30, windows: [] },
        scheduleState: { checkedAt: null, emptySince: null },
        playerAccess: null,
        gamePort: 19133,
        queryPort: 19135,
        arkAccess: {
            closed: true,
            logging: true,
            players: [
                { steamId: "76561198000000001", label: "Pau", addedAt: "2026-08-10T10:00:00.000Z", appliedAt: "2026-08-10T10:01:00.000Z" },
                { steamId: "76561198000000002", label: "Ana", addedAt: "2026-08-10T10:00:00.000Z", appliedAt: null }
            ]
        },
        ...overrides
    };
}

function render(game: GameContext | null): string {
    return renderToStaticMarkup(
        <ArkPanel
            installedAppId={INSTALL}
            applicationId="bbbbbbbb-1111-4111-8111-111111111111"
            settings={[]}
            running
            game={game}
            held={["games.read", "games.moderate", "games.manage"]}
        />
    );
}

describe("the ARK panel before the server has answered", () => {
    it("lists everybody who may join, without waiting for a read of the server", () => {
        const markup = render(context());

        expect(markup).toContain("Pau");
        expect(markup).toContain("Ana");
        expect(markup).toContain("76561198000000001");
    });

    it("says nothing about who is playing until it has been told", () => {
        // Not "Offline": nobody has been asked yet. The row carries a placeholder
        // where the answer will go.
        expect(render(context())).not.toContain("Offline");
    });

    it("shows both join addresses it already knows rather than a skeleton", () => {
        const markup = render(context());

        // The one nobody can work out for themselves: Steam is given the query
        // port, not the game port, and pasting the wrong one is answered with
        // "server not found" - which names neither the port nor the mistake.
        expect(markup).toContain("los-payasos-gaming.ark.example.com:19135");
        expect(markup).toContain("open los-payasos-gaming.ark.example.com:19133");
    });

    it("offers adding somebody as a button rather than fields under the table", () => {
        expect(render(context())).toContain("Add player");
    });

    it("still renders for a server whose facts are not there at all", () => {
        // An install that was never deployed has no context. The page it belongs to
        // is the one somebody opens to find out why.
        expect(() => render(null)).not.toThrow();
    });
});
