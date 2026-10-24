/**
 * A task by its public link (/t/<token>).
 *
 * Outside the app shell and outside authentication: whoever holds the link can
 * read the work, and nothing else. A token that names no live share renders the
 * same "not available" page as one that was turned off, so the URL cannot be
 * used to test which tokens exist.
 *
 * Read-only on purpose. Somebody outside Polaris wants to know where their thing
 * is; letting them change it would need an identity Polaris does not have for
 * them, and a comment box open to the internet is a comment box open to the
 * internet.
 */

import Link from "next/link";
import { LogIn } from "lucide-react";
import { getSession } from "@/lib/session";
import { signInHref } from "@/lib/safe-redirect";
import { getTranslations } from "@/lib/i18n/request";
import { getPublicTask } from "@/lib/tasks/share-service";
import { TaskCard } from "./task-card";
import { gateTaskShare } from "@/lib/tasks/share-access";
import { linkDenialMessage } from "@/lib/link-denial";
import { LinkPasswordForm } from "@/components/link-password-form";
import { unlockTaskShareAction } from "./actions";
import { Button, PolarisMark } from "@polaris/ui";

export const dynamic = "force-dynamic";

function Shell({
    children,
    signedIn,
    signInLabel,
    back
}: {
    children: React.ReactNode;
    signedIn: boolean;
    signInLabel: string;
    /** This page, for the sign-in screen to return to. */
    back: string;
}) {
    return (
        <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-muted-foreground">
                    <PolarisMark className="size-6" />
                    {/* i18n-ignore: the product's name */}
                    <span className="text-sm font-medium">Polaris</span>
                </div>
                {!signedIn && (
                    <Button asChild size="sm" variant="ghost">
                        <Link href={signInHref(back)}>
                            <LogIn className="size-4" />
                            {signInLabel}
                        </Link>
                    </Button>
                )}
            </header>
            {children}
        </div>
    );
}

export default async function PublicTaskPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    // The gate runs before anything is read: a link with a password, an expiry
    // or an address rule must not count a view it did not serve.
    const gate = await gateTaskShare(token);
    if (!gate.ok && gate.reason === "password_required") {
        return <LinkPasswordForm token={token} unlock={unlockTaskShareAction} />;
    }
    const [task, session, t] = await Promise.all([
        gate.ok ? getPublicTask(token) : null,
        getSession(),
        getTranslations("publicPages")
    ]);
    const signedIn = session?.user !== undefined;

    if (!task) {
        return (
            <Shell signedIn={signedIn} signInLabel={t("task.signIn")} back={`/t/${token}`}>
                <div className="flex flex-1 flex-col items-center justify-center text-center">
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                        {t("task.unavailableTitle")}
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {gate.ok || gate.reason === "not_found"
                            ? t("task.unavailable")
                            : await linkDenialMessage(gate.reason)}
                    </p>
                </div>
            </Shell>
        );
    }

    return (
        <Shell signedIn={signedIn} signInLabel={t("task.signIn")} back={`/t/${token}`}>
            <TaskCard task={task} />
        </Shell>
    );
}
