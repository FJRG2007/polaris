/**
 * The groups, roles and organizations screens, drawn in Spanish.
 *
 * What is asserted is what a migration gets wrong without noticing: a count
 * that has to agree with its number, the permission grid whose names used to
 * come from a constant in core, and the organization policy's option hints,
 * which did too.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
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
vi.mock("@/app/(app)/admin/roles/actions", () => ({
    createRoleAction: async () => ({}),
    deleteRoleAction: async () => ({}),
    setRolePermissionsAction: async () => ({})
}));
vi.mock("@/app/(app)/view-as-actions", () => ({ viewAsRoleAction: async () => ({}) }));

vi.mock("@/app/(app)/admin/organizations/actions", () => ({
    listOrgDirectoryAction: async () => ({ items: [], next: null }),
    saveOrganizationPolicyAction: async () => ({})
}));

const { GroupsAdmin } = await import("@/app/(app)/admin/groups/groups-admin");
const { RolesAdmin } = await import("@/app/(app)/admin/roles/roles-admin");
const { OrganizationsAdmin } = await import("@/app/(app)/admin/organizations/organizations-admin");

describe("the groups directory in Spanish", () => {
    const markup = renderToStaticMarkup(
        withMessages(
            <GroupsAdmin
                groups={[
                    {
                        id: "g1",
                        name: "Operations",
                        description: null,
                        isSystem: true,
                        memberCount: 2,
                        members: {
                            items: [
                                { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
                                { id: "u2", name: "Alan Turing", email: "alan@example.com" }
                            ],
                            next: null
                        }
                    }
                ]}
            />,
            "es-ES"
        )
    );

    it("counts the people in Spanish", () => {
        expect(markup).toContain("2 personas");
        expect(markup).not.toContain("2 people");
    });

    it("draws the table and the search in Spanish", () => {
        expect(markup).toContain("Buscar por grupo, descripción o miembro");
        expect(markup).toContain("Nuevo grupo");
        expect(markup).toContain("Sin descripción.");
        expect(markup).toContain("sistema");
        expect(markup).not.toContain("New group");
    });
});

describe("the roles editor in Spanish", () => {
    const markup = renderToStaticMarkup(
        withMessages(
            <RolesAdmin
                roles={[
                    {
                        id: "r1",
                        name: "member",
                        isSystem: true,
                        wildcard: false,
                        permissions: ["drive.read"],
                        memberCount: 1
                    }
                ]}
            />,
            "es-ES"
        )
    );

    it("names the areas and permissions in Spanish", () => {
        expect(markup).toContain("Juegos");
        expect(markup).toContain("Ver archivos y descargarlos");
        expect(markup).not.toContain("See files and download them");
    });

    it("keeps the role's own name and counts its holders", () => {
        expect(markup).toContain("member");
        expect(markup).toContain("1 persona");
        expect(markup).toContain("predefinido");
        expect(markup).toContain("Ver como");
    });
});

describe("the organizations directory in Spanish", () => {
    const markup = renderToStaticMarkup(
        withMessages(
            <OrganizationsAdmin
                initial={{
                    creation: "admins",
                    maxPerUser: 0,
                    maxMembers: 5,
                    maxTeams: 0,
                    newPeople: "off",
                    invitesPerHour: 20
                }}
                save={async () => ({})}
                first={{ items: [], next: null }}
            />,
            "es-ES"
        )
    );

    it("asks the policy questions in Spanish", () => {
        expect(markup).toContain("Quién puede crear una organización");
        expect(markup).toContain("Solo los administradores pueden, y ellos añaden a las personas.");
        expect(markup).toContain(
            "Las organizaciones solo invitan a personas que ya tienen cuenta."
        );
        expect(markup).toContain("Sin límite.");
        expect(markup).toContain("Incluye al propietario.");
        expect(markup).not.toContain("Who can create an organization");
    });

    it("says so when there are none", () => {
        expect(markup).toContain("Nadie ha creado ninguna todavía.");
    });
});
