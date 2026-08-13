/**
 * What the people directory says about who is here.
 *
 * It used to print one timestamp per account and nothing else, so an operator
 * reading it could not tell somebody signed in right now from somebody last seen
 * in July - and the stamp behind it only moved on dashboard requests, which is why
 * it read as days old for people who were using Polaris the whole time.
 *
 * Rendered to static markup: this is about what the row states.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DirectoryUser } from "@/lib/user-admin-service";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));
vi.mock("@/components/relative-time", () => ({
    RelativeTime: ({ iso }: { iso: string }) => `relative:${iso}`
}));
vi.mock("@/components/avatar", () => ({ Avatar: () => null }));
// The screen's own server modules: importing them for real drags in the auth stack
// and its environment, none of which this is about.
vi.mock("../../src/app/(app)/admin/users/actions", () => ({
    revokeInviteAction: async () => ({})
}));
vi.mock("../../src/app/(app)/admin/users/invite-dialog", () => ({ InviteDialog: () => null }));
vi.mock("../../src/app/(app)/admin/users/recovery-requests", () => ({
    RecoveryRequests: () => null
}));

const { UsersAdmin } = await import("../../src/app/(app)/admin/users/users-admin");

const HERE = new Date(Date.now() - 20_000).toISOString();
const GONE = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString();

function person(overrides: Partial<DirectoryUser>): DirectoryUser {
    return {
        id: "018f2b7a-0000-7000-8000-00000000000a",
        name: "Someone",
        email: "someone@example.com",
        username: null,
        company: null,
        isAdmin: false,
        banned: false,
        banReason: null,
        bannedAt: null,
        emailVerified: true,
        twoFactorEnabled: false,
        roles: [],
        groups: [],
        lastSeenAt: null,
        lastIp: null,
        lastCountry: null,
        createdAt: new Date("2026-07-18T00:00:00.000Z").toISOString(),
        enforced: { groupIds: [], allowedCidrs: [], allowedCountries: [], allowedContinents: [] },
        ...overrides
    } as DirectoryUser;
}

function markup(users: DirectoryUser[]): string {
    return renderToStaticMarkup(
        <UsersAdmin
            users={users}
            invites={[]}
            recoveries={[]}
            groups={[]}
            roles={[]}
            canSendMail={false}
            viewerId="018f2b7a-0000-7000-8000-0000000000ff"
        />
    );
}

describe("the people directory", () => {
    it("marks someone active right now as online", () => {
        const html = markup([person({ name: "Present", lastSeenAt: HERE })]);

        expect(html).toContain("Online");
    });

    it("gives someone who has gone their last time instead", () => {
        const html = markup([person({ name: "Absent", lastSeenAt: GONE })]);

        expect(html).not.toContain(">Online<");
        expect(html).toContain(`relative:${GONE}`);
    });

    it("says never rather than online for an account that has never signed in", () => {
        const html = markup([person({ name: "New", lastSeenAt: null })]);

        expect(html).toContain("Never");
        expect(html).not.toContain(">Online<");
    });
});
