/**
 * Where a confirmation link lands. The token is spent server-side on render, so
 * the outcome is already decided by the time anything is shown - there is no
 * button here to press, and no state a reload could replay.
 *
 * Deliberately open to anyone holding the link: the token is the proof, and
 * requiring a session first would strand a user who opened the message on a
 * device they are not signed in on, which is most of them.
 */

import Link from "next/link";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import { consumeEmailVerification } from "@/lib/email-verification-service";

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({
    searchParams
}: {
    searchParams: Promise<{ token?: string }>;
}) {
    const { token } = await searchParams;
    const verified = token ? await consumeEmailVerification(token) : null;
    const t = await getTranslations("auth");

    return (
        <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
            {verified ? (
                <>
                    <CheckCircle2 className="size-10 text-success" />
                    <div>
                        <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("verifyEmail.confirmed")}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t("verifyEmail.verified", {
                                email: verified.email,
                                primary: verified.primary ? "yes" : "no"
                            })}
                        </p>
                    </div>
                </>
            ) : (
                <>
                    <XCircle className="size-10 text-danger" />
                    <div>
                        <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("verifyEmail.failedTitle")}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">{t("verifyEmail.failedBody")}</p>
                    </div>
                </>
            )}
            <Button asChild>
                {/* The addresses, not the profile: this is where somebody
                    lands after confirming one, and where they go to ask for
                    another when the link did not work. */}
                <Link href="/account/details">{t("verifyEmail.addresses")}</Link>
            </Button>
        </div>
    );
}
