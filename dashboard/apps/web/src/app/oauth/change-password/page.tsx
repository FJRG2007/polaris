/**
 * Where an account holding a temporary password picks its own.
 *
 * The session guard sends every request here while the hold is set, so this page
 * resolves the session itself instead of calling requireUser, which would send
 * it straight back.
 */

import { redirect } from "next/navigation";
import { resolveSession } from "@/lib/session";
import { ChangePasswordForm } from "./change-password-form";
import { owesPasswordChange } from "@/lib/admin-credentials-service";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
    const session = await resolveSession();
    if (!session) redirect("/oauth/login");
    // Nothing owed is also how a finished change leaves this page.
    if (!(await owesPasswordChange(session.id))) redirect("/");
    return <ChangePasswordForm account={session.email} name={session.name} />;
}
