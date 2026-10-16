/**
 * Management > Single sign-on: the SAML identity providers people sign in
 * through, and the domains each one answers for.
 *
 * The heading is drawn before the providers are read; only the list waits, under
 * a skeleton shaped like a provider card.
 */

import { Suspense } from "react";
import { SsoAdmin } from "./sso-admin";
import { requireAdmin } from "@/lib/session";
import { PageHeader, Skeleton } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import { listSamlProviders } from "@/lib/saml-providers";

export const dynamic = "force-dynamic";

async function Providers() {
    return <SsoAdmin providers={await listSamlProviders()} />;
}

function ProvidersSkeleton() {
    return (
        <div className="flex max-w-3xl flex-col gap-3" aria-hidden>
            <div className="flex flex-col gap-3 rounded-lg border p-4">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
            </div>
            <Skeleton className="h-9 w-32" />
        </div>
    );
}

export default async function AdminSsoPage() {
    const [, t] = await Promise.all([requireAdmin(), getTranslations("admin")]);
    return (
        <>
            <PageHeader title={t("sso.title")} description={t("sso.description")} />
            <Suspense fallback={<ProvidersSkeleton />}>
                <Providers />
            </Suspense>
        </>
    );
}
