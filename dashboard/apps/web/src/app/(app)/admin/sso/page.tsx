/**
 * Management > Single sign-on: the SAML identity providers people sign in
 * through, and the domains each one answers for.
 */

import { SsoAdmin } from "./sso-admin";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { listSamlProviders } from "@/lib/saml-providers";

export const dynamic = "force-dynamic";

export default async function AdminSsoPage() {
    await requireAdmin();
    const [providers, t] = await Promise.all([listSamlProviders(), getTranslations("admin")]);
    return (
        <>
            <PageHeader title={t("sso.title")} description={t("sso.description")} />
            <SsoAdmin providers={providers} />
        </>
    );
}
