/**
 * The two admin directories that were redesigned to read like the people one.
 *
 * What is asserted is what the redesign was for: the facts an operator scans -
 * a group's name and who is in it, an organization's handle, owner and size -
 * are in the table itself, rather than behind a card each. The dialogs and the
 * policy form below them are ordinary controls and are left to the browser.
 */

import { describe, expect, it, vi } from "vitest";
import { withMessages } from "../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/app/(app)/admin/groups/actions", () => ({
    addGroupMemberAction: async () => undefined,
    createGroupAction: async () => ({}),
    deleteGroupAction: async () => undefined,
    removeGroupMemberAction: async () => undefined,
    listGroupMembersAction: async () => ({ items: [], next: null }),
    findGroupsByMemberAction: async () => ({ ids: [] }),
    findGroupCandidatesAction: async () => ({ results: [] })
}));

vi.mock("@/app/(app)/admin/organizations/actions", () => ({
    listOrgDirectoryAction: async () => ({ items: [], next: null }),
    saveOrganizationPolicyAction: async () => ({})
}));

const { GroupsAdmin } = await import("@/app/(app)/admin/groups/groups-admin");
const { OrganizationsAdmin } = await import("@/app/(app)/admin/organizations/organizations-admin");

describe("the groups directory", () => {
    const markup = renderToStaticMarkup(
        withMessages(<GroupsAdmin
            groups={[
                {
                    id: "g1",
                    name: "Operations",
                    description: "Runs the boxes",
                    isSystem: false,
                    memberCount: 1,
                    members: { items: [{ id: "u1", name: "Ada Lovelace", email: "ada@example.com" }], next: null }
                },
                { id: "g2", name: "Everyone", description: null, isSystem: true, memberCount: 0, members: { items: [], next: null } }
            ]}
        />)
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

    it("counts the whole roster when only its first page arrived", () => {
        const big = renderToStaticMarkup(
            withMessages(<GroupsAdmin
                groups={[
                    {
                        id: "g3",
                        name: "Customers",
                        description: null,
                        isSystem: false,
                        memberCount: 4000,
                        members: { items: [{ id: "u1", name: "Ada Lovelace", email: "ada@example.com" }], next: "u1" }
                    }
                ]}
            />)
        );
        expect(big).toContain("4,000 people");
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
        withMessages(<OrganizationsAdmin
            initial={{ creation: "anyone", maxPerUser: 0, maxMembers: 0, maxTeams: 0 }}
            save={async () => ({})}
            first={{
                items: [
                    {
                        id: "o1",
                        slug: "acme",
                        name: "Acme",
                        ownerName: "Ada Lovelace",
                        memberCount: 4,
                        teamCount: 2,
                        spaceCount: 1
                    }
                ],
                next: "more"
            }}
        />)
    );

    it("lists what exists before the policy about it", () => {
        expect(markup.indexOf("Acme")).toBeLessThan(markup.indexOf("Policy"));
    });

    it("carries the handle, the owner and the size", () => {
        expect(markup).toContain("@acme");
        expect(markup).toContain("Ada Lovelace");
        expect(markup).toContain(">4<");
    });

    it("offers the next page without pushing the policy away", () => {
        expect(markup).toContain("Show more organizations");
    });

    it("still asks who may create one", () => {
        expect(markup).toContain("Who can create an organization");
    });
});
