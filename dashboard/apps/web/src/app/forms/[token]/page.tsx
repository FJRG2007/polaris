/**
 * A public intake form (/forms/<token>).
 *
 * Outside the app shell and outside authentication: anyone with the link can
 * open it. A token that names no live form renders the same "not available"
 * page as a disabled one, so the URL cannot be used to test which tokens exist.
 */

import { PublicForm } from "./form-view";
import { getSession } from "@/lib/session";
import { Messages } from "@/components/i18n/messages";
import { getTranslations } from "@/lib/i18n/request";
import { getPublicForm } from "@/lib/tasks/form-service";
import { gateTaskForm } from "@/lib/tasks/form-access";
import { linkDenialMessage } from "@/lib/link-denial";
import { LinkPasswordForm } from "@/components/link-password-form";
import { unlockFormAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function PublicFormPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    // The gate runs before the form is read: a form behind a password, an
    // expiry, a cap or an address rule shows nothing of itself until it opens.
    const gate = await gateTaskForm(token);
    if (!gate.ok && gate.reason === "password_required") {
        return <LinkPasswordForm token={token} unlock={unlockFormAction} />;
    }
    const form = gate.ok ? await getPublicForm(token) : null;
    const session = await getSession();
    const t = await getTranslations("publicPages");

    return (
        <main className="flex min-h-dvh items-center justify-center bg-background p-6">
            {form ? (
                <Messages namespaces={["publicPages"]}>
                    <PublicForm
                        token={token}
                        name={form.name}
                        intro={form.intro}
                        fields={form.fields}
                        requireLogin={form.requireLogin}
                        signedIn={session?.user !== undefined}
                    />
                </Messages>
            ) : (
                <div className="text-center">
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("form.unavailableTitle")}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {gate.ok || gate.reason === "not_found"
                            ? t("form.unavailable")
                            : await linkDenialMessage(gate.reason)}
                    </p>
                </div>
            )}
        </main>
    );
}
