/**
 * A public intake form (/forms/<token>).
 *
 * Outside the app shell and outside authentication: anyone with the link can
 * open it. A token that names no live form renders the same "not available"
 * page as a disabled one, so the URL cannot be used to test which tokens exist.
 */

import { PublicForm } from "./form-view";
import { getSession } from "@/lib/session";
import { getPublicForm } from "@/lib/tasks/form-service";

export const dynamic = "force-dynamic";

export default async function PublicFormPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const form = await getPublicForm(token);
    const session = await getSession();

    return (
        <main className="flex min-h-dvh items-center justify-center bg-background p-6">
            {form ? (
                <PublicForm
                    token={token}
                    name={form.name}
                    intro={form.intro}
                    fields={form.fields}
                    requireLogin={form.requireLogin}
                    signedIn={session?.user !== undefined}
                />
            ) : (
                <div className="text-center">
                    <h1 className="text-[17px] font-semibold tracking-tight">This form is not available</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        The link may have expired, or the form may have been closed.
                    </p>
                </div>
            )}
        </main>
    );
}
