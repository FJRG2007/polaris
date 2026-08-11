import type { Metadata } from "next";
import { LegalDocumentView } from "../document";
import { getLegalContact } from "@/lib/legal/service";
import { termsDocument } from "@/lib/legal/documents";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Terms - Polaris",
    description: "The terms this Polaris deployment is offered under."
};

export default async function TermsPage() {
    return <LegalDocumentView document={termsDocument(await getLegalContact())} />;
}
