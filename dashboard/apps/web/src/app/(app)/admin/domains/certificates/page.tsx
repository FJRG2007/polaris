/**
 * Certificates (/admin/domains/certificates): the root certificate that makes
 * `polaris.local` trusted, and the contact the public certificate authority writes
 * to. Admin-only.
 *
 * Awaits nothing but the admin check: the contact card asks the host daemon about the edge, after the first paint.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { LocalCertificate } from "@/app/(app)/admin/domains/domains-view";
import { CertificateContactCard } from "@/app/(app)/admin/domains/certificate-contact-card";

export const dynamic = "force-dynamic";

export default async function CertificatesPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col">
            <PageHeader
                title={t("domains.pages.certificates.title")}
                description={t("domains.pages.certificates.description")}
            />
            <div className="flex w-full flex-col gap-6">
                <LocalCertificate />
                <CertificateContactCard />
            </div>
        </div>
    );
}
