import type { Metadata } from "next";
import { LegalDocumentView } from "../document";
import { getLegalContact } from "@/lib/legal/service";
import { privacyDocument } from "@/lib/legal/documents";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Privacy - Polaris",
    description: "What Polaris stores, where it stays, and what happens to it when you unlink or leave."
};

/** The privacy policy this deployment declares to Google and Epic. Public: a
 *  policy nobody can open without an account is not one a review desk accepts. */
export default async function PrivacyPage() {
    return <LegalDocumentView document={privacyDocument(await getLegalContact())} />;
}
