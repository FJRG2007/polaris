"use server";

import { requireAdmin } from "@/lib/session";
import { organizationPolicy } from "@/lib/orgs/policy";
import { listOrgDirectoryPage } from "@/lib/org-directory";

/** The organization policy and the first page of the directory, after the paint. */
export async function loadOrganizationsAdminAction() {
    await requireAdmin();
    const [policy, orgs] = await Promise.all([organizationPolicy(), listOrgDirectoryPage()]);
    return { policy, orgs };
}
