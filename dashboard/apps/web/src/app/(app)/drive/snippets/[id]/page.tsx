/**
 * One snippet (/drive/snippets/[id]): its text, editable in place.
 *
 * A sealed snippet is the exception. Polaris holds ciphertext for it, so there
 * is nothing to show and nothing to edit here - the page says so and offers the
 * things that still make sense: the link, and deleting it.
 */

import Link from "next/link";
import { getTranslations } from "@/lib/i18n/request";
import { EyeOff } from "lucide-react";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { SnippetEditor } from "../snippet-editor";
import { Button, Card, CardBody } from "@polaris/ui";
import { getSnippetForOwner } from "@/lib/snippet-service";

export const dynamic = "force-dynamic";

export default async function SnippetPage({ params }: { params: Promise<{ id: string }> }) {
    const t = await getTranslations("drive");
    const { id } = await params;
    const user = await requirePermission("snippets.write");
    const snippet = await getSnippetForOwner(user.id, id);
    if (!snippet) notFound();

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{snippet.title}</h1>
                <p className="text-sm text-muted-foreground">
                    {snippet.description ??
                        (snippet.requestId
                            ? t("pages.snippets.collected")
                            : t("pages.snippets.editHint"))}
                </p>
            </div>

            {snippet.clientSealed ? (
                <Card>
                    <CardBody className="flex flex-col items-center gap-3 p-8 text-center">
                        <EyeOff className="size-5 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                            {t("pages.snippets.sealed")}
                        </p>
                        <Button asChild variant="secondary" size="sm">
                            <Link href="/drive/snippets">{t("pages.snippets.back")}</Link>
                        </Button>
                    </CardBody>
                </Card>
            ) : (
                <SnippetEditor
                    snippet={{
                        id: snippet.id,
                        title: snippet.title,
                        description: snippet.description,
                        files: snippet.files.map((file) => ({
                            name: file.name,
                            language: file.language,
                            body: file.body
                        }))
                    }}
                />
            )}
        </div>
    );
}
