import type { Metadata } from "next";
import { LegalDocumentView } from "../document";
import { getLegalContact } from "@/lib/legal/service";
import { privacyDocument } from "@/lib/legal/documents";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("publicPages");
    return { title: t("legal.privacyTitle"), description: t("legal.privacyDescription") };
}

/** The privacy policy this deployment declares to Google and Epic. Public: a
 *  policy nobody can open without an account is not one a review desk accepts. */
export default async function PrivacyPage() {
    const t = await getTranslations("publicPages");
    const legal = privacyDocument(await getLegalContact());
    return <LegalDocumentView document={{ ...legal, title: t("layout.privacy") }} />;
}
