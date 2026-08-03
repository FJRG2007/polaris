/**
 * Roles admin. The answer to "what can a member actually do" - a question that
 * had no screen before this one, because the seeded roles were only ever a
 * constant in the source.
 */

import { PageHeader } from "@polaris/ui";
import { RolesAdmin } from "./roles-admin";
import { requireAdmin } from "@/lib/session";
import { listRoles } from "@/lib/role-service";

export const dynamic = "force-dynamic";

export default async function RolesAdminPage() {
    await requireAdmin();
    const roles = await listRoles();

    return (
        <>
            <PageHeader
                title="Roles"
                description="What each role may do. Everyone holds one, and it decides which apps they even see."
            />
            <RolesAdmin roles={roles} />
        </>
    );
}
