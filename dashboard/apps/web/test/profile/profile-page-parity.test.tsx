// @vitest-environment jsdom

/**
 * Somebody's page shows what their profile in chat shows.
 *
 * The page used to stop at the name, the handle and what the two of you have in
 * common, while the card in chat carried what they are doing, what they did
 * lately, what they wrote and since when you are friends. Drawn here through the
 * real presence store, fed by a stubbed `/api/presence`, because "the activity
 * never appears on the page" was the report and the store is where it comes in.
 */

import type { ReactNode } from "react";
import { withMessages } from "../setup/i18n";
import type { PublicProfile } from "@/lib/profile-service";
import { PresenceProvider } from "@/components/presence-store";
import { PersonPressContext } from "@/components/person-press";
import { SessionScopeProvider } from "@/components/session-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    usePathname: () => "/u/fixture.person"
}));
vi.mock("@/lib/session", () => ({ currentUser: async () => null, guardedUser: async () => null }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/app/u/[username]/profile-actions", () => ({ ProfileActions: () => null }));
vi.mock("@/app/u/[username]/follow-lists", () => ({ FollowLists: () => null }));

const { ProfileCard } = await import("@/app/u/[username]/profile-card");
const { CallRosterList } = await import("@/app/(app)/chat/call-roster");

const PERSON = "00000000-0000-4000-8000-000000000002";

const profile: PublicProfile = {
    id: PERSON,
    name: "Fixture Person",
    username: "fixture.person",
    headline: "Fixture headline",
    pronouns: "they/them",
    links: [],
    fullName: "",
    description: "Fixture bio",
    showsAvatar: true,
    style: {} as PublicProfile["style"],
    organizations: [],
    companies: [],
    email: "",
    joinedAt: "2021-03-04T12:00:00.000Z",
    follows: { followers: 0, following: 0, showsNames: false },
    standing: {
        friendship: "friends",
        following: false,
        canMessage: true,
        blocked: false,
        canAskToBeFriends: false
    },
    mutual: null,
    restricted: false,
    recent: [
        {
            key: "recent-1",
            source: "game",
            name: "Fixture Recent Game",
            details: "",
            imageUrl: null,
            gameId: null,
            endedAt: "2026-11-20T10:00:00.000Z"
        } as PublicProfile["recent"][number]
    ],
    friendsSince: "2024-06-01T12:00:00.000Z"
};

const NO_BADGES = { shown: [], available: [], arrangement: null };

function frame(node: ReactNode) {
    return withMessages(
        <SessionScopeProvider userId="00000000-0000-4000-8000-000000000001">
            <PresenceProvider>{node}</PresenceProvider>
        </SessionScopeProvider>
    );
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: string }) => {
            const { ids } = JSON.parse(init.body) as { ids: string[] };
            const people = Object.fromEntries(
                ids.map((id) => [
                    id,
                    {
                        status: "online",
                        note: "",
                        inCall: null,
                        // What /api/presence hands a reader the activity audience
                        // lets in - somebody who shares a room with them.
                        activity: [
                            {
                                source: "game",
                                key: "game-1",
                                name: "Fixture Live Game",
                                details: "",
                                state: "",
                                imageUrl: null,
                                linkUrl: null,
                                startedAt: new Date(Date.now() - 60_000).toISOString(),
                                endsAt: null
                            }
                        ]
                    }
                ])
            );
            return new Response(JSON.stringify({ people }));
        })
    );
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("somebody's page", () => {
    it("draws what they are doing right now, from the presence store", async () => {
        render(
            frame(
                <ProfileCard profile={profile} own={false} signedIn badges={NO_BADGES} tag={null} />
            )
        );
        await act(async () => vi.advanceTimersByTimeAsync(200));
        expect(screen.getAllByText(/Fixture Live Game/).length).toBeGreaterThan(0);
    });

    it("draws what they did lately, what they wrote and since when you are friends", () => {
        render(
            frame(
                <ProfileCard profile={profile} own={false} signedIn badges={NO_BADGES} tag={null} />
            )
        );
        expect(screen.getByText("Recent activity")).toBeDefined();
        expect(screen.getByText("Fixture Recent Game")).toBeDefined();
        expect(screen.getByText("About me")).toBeDefined();
        expect(screen.getByText("Fixture bio")).toBeDefined();
        expect(screen.getByText("Member since")).toBeDefined();
        expect(screen.getByText("Friends since")).toBeDefined();
        expect(screen.getByText("Jun 1, 2024")).toBeDefined();
    });

    it("draws none of it for a reader outside the profile audience", () => {
        render(
            frame(
                <ProfileCard
                    profile={{
                        ...profile,
                        description: "",
                        joinedAt: "",
                        recent: [],
                        friendsSince: "",
                        restricted: true
                    }}
                    own={false}
                    signedIn
                    badges={NO_BADGES}
                    tag={null}
                />
            )
        );
        expect(screen.queryByText("Recent activity")).toBeNull();
        expect(screen.queryByText("Friends since")).toBeNull();
        expect(screen.queryByText("Member since")).toBeNull();
        expect(screen.getByText("This profile is private.")).toBeDefined();
    });
});

describe("the people in a voice room", () => {
    const people = [
        { id: "seat-1", userId: PERSON, name: "Fixture Person", streaming: false },
        { id: "seat-2", userId: null, name: "Fixture Guest", streaming: false }
    ] as unknown as Parameters<typeof CallRosterList>[0]["people"];

    it("opens somebody's card when their row is pressed", () => {
        const press = vi.fn();
        render(
            withMessages(
                <PersonPressContext.Provider value={press}>
                    <CallRosterList people={people} />
                </PersonPressContext.Provider>
            )
        );
        fireEvent.click(screen.getByTitle("View Fixture Person's profile"));
        expect(press).toHaveBeenCalledWith(
            { id: PERSON, name: "Fixture Person" },
            expect.any(HTMLElement)
        );
        // A guest has no account and so no card to open.
        expect(screen.queryByTitle("View Fixture Guest's profile")).toBeNull();
    });
});
