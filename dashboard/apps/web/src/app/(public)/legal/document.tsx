import { LEGAL_UPDATED } from "@/lib/legal/documents";
import type { LegalDocument } from "@/lib/legal/documents";

/** One legal page, rendered the same way whichever document it is. Prose only:
 *  these are read by people and by review desks, and neither wants chrome. */
export function LegalDocumentView({ document }: { document: LegalDocument }) {
    return (
        <article className="flex flex-col gap-6">
            <header className="flex flex-col gap-1">
                <h1 className="text-xl font-medium">
                    {document.title} <span className="text-muted-foreground">- Polaris</span>
                </h1>
                <p className="text-sm text-muted-foreground">{document.summary}</p>
                <p className="text-xs text-muted-foreground">Last updated {LEGAL_UPDATED}.</p>
            </header>

            {document.sections.map((section) => (
                <section key={section.heading} className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium">{section.heading}</h2>
                    {section.body.map((paragraph) => (
                        <p key={paragraph} className="text-sm leading-relaxed text-muted-foreground">
                            {paragraph}
                        </p>
                    ))}
                </section>
            ))}
        </article>
    );
}
