/**
 * The two admin directories that were redesigned to read like the people one.
 *
 * What is asserted is what the redesign was for: the facts an operator scans -
 * a group's name and who is in it, an organization's handle, owner and size -
 * are in the table itself, rather than behind a card each. The dialogs and the
 * policy form below them are ordinary controls and are left to the browser.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/app/(app)/admin/groups/actions", () => ({
    addGroupMemberAction: async () => undefined,
    createGroupAction: async () => ({}),
    deleteGroupAction: async () => undefined,
    removeGroupMemberAction: async () => undefined
}));

const { GroupsAdmin } = await import("@/app/(app)/admin/groups/groups-admin");
const { OrganizationsAdmin } = await import("@/app/(app)/admin/organizations/organizations-admin");

describe("the groups directory", () => {
    const markup = renderToStaticMarkup(
        <GroupsAdmin
            groups={[
                {
                    id: "g1",
                    name: "Operations",
                    description: "Runs the boxes",
                    isSystem: false,
                    members: [{ id: "u1", name: "Ada Lovelace", email: "ada@example.com" }]
                },
                { id: "g2", name: "Everyone", description: null, isSystem: true, members: [] }
            ]}
            users={[{ id: "u2", name: "Alan Turing", email: "alan@example.com" }]}
        />
    );

    it("puts each group in a row of one table", () => {
        expect(markup).toContain("Operations");
        expect(markup).toContain("Runs the boxes");
        expect(markup).toContain("Everyone");
        expect(markup.match(/<table/g) ?? []).toHaveLength(1);
    });

    it("says how many people are in one without opening it", () => {
        expect(markup).toContain("1 person");
    });

    it("marks the group nobody may delete", () => {
        expect(markup).toContain("system");
    });

    it("offers the search and the way to make a new one", () => {
        expect(markup).toContain("Search by group, description or member");
        expect(markup).toContain("New group");
    });
});

describe("the organizations directory", () => {
    const markup = renderToStaticMarkup(
        <OrganizationsAdmin
            initial={{ creation: "anyone", maxPerUser: 0, maxMembers: 0, maxTeams: 0 }}
            save={async () => ({})}
            orgs={[
                {
                    id: "o1",
                    slug: "acme",
                    name: "Acme",
                    ownerName: "Ada Lovelace",
                    memberCount: 4,
                    teamCount: 2,
                    spaceCount: 1
                }
            ]}
        />
    );

    it("lists what exists before the policy about it", () => {
        expect(markup.indexOf("Acme")).toBeLessThan(markup.indexOf("Policy"));
    });

    it("carries the handle, the owner and the size", () => {
        expect(markup).toContain("@acme");
        expect(markup).toContain("Ada Lovelace");
        expect(markup).toContain(">4<");
    });

    it("still asks who may create one", () => {
        expect(markup).toContain("Who can create an organization");
    });
});
