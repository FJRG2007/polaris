import type { Metadata } from "next";
import { LegalDocumentView } from "../document";
import { getLegalContact } from "@/lib/legal/service";
import { termsDocument } from "@/lib/legal/documents";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("publicPages");
    return { title: t("legal.termsTitle"), description: t("legal.termsDescription") };
}

export default async function TermsPage() {
    return <LegalDocumentView document={termsDocument(await getLegalContact())} />;
}
