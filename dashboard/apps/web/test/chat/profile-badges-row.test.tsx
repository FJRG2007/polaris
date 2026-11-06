// @vitest-environment jsdom

/**
 * The badges beside a person's handle, on every size a chat profile is drawn
 * at - the column, the card a pressed name opens, and the larger view - so a
 * badge is beside the name everywhere or nowhere.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { ChatProfile } from "@/lib/chat/profiles";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ProfileDetails, type ProfileSize } from "@/app/(app)/chat/profile-details";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({ channels: [], setActiveSpaceId: () => undefined })
}));
vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));

const BADGE = {
    key: "custom:founder",
    kind: "custom",
    category: "custom",
    icon: "award",
    name: "Founder",
    description: null,
    owned: true,
    level: 1,
    top: 1,
    levelName: null,
    unlockedAt: null,
    rarity: 1,
    unit: null,
    progress: null,
    levels: []
} as const;

function profile(badges: ChatProfile["badges"]): ChatProfile {
    return {
        name: "Grace Hopper",
        fullName: "",
        username: "grace",
        description: "",
        headline: "",
        pronouns: "",
        mutual: { friends: { people: [], total: 0 }, spaces: { spaces: [], total: 0 } },
        role: null,
        restricted: false,
        badges,
        memberSince: "",
        friendship: "none"
    };
}

function draw(size: ProfileSize, badges: ChatProfile["badges"]) {
    return render(
        <ProfileDetails
            size={size}
            person={{ id: "grace", name: "Grace Hopper" }}
            profile={profile(badges)}
            loading={false}
        />,
        { wrapper: MessagesWrapper }
    );
}

afterEach(cleanup);

describe("the badge row beside the handle", () => {
    for (const size of ["panel", "card", "full"] as const) {
        it(`is drawn on the ${size}`, () => {
            draw(size, [{ ...BADGE }]);
            const row = screen.getByRole("list", { name: "Badges" });
            expect(within(row).getByRole("button", { name: "Open Founder" })).toBeTruthy();
            // In the same row as the handle, which is the way to their page.
            expect(row.parentElement?.querySelector('a[href="/u/grace"]')).not.toBeNull();
        });
    }

    it("is not drawn for somebody with no badges this reader may see", () => {
        draw("full", []);
        expect(screen.queryByRole("list", { name: "Badges" })).toBeNull();
        expect(screen.getByText("grace")).toBeTruthy();
    });
});
