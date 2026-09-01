/**
 * "Snippets" (/drive/snippets): text this account holds and can hand out by
 * link - a config file, an .env, a stack trace, a few files of code. Sits beside
 * Shared links and Drop points because it is the same act as sharing a file,
 * with content that was never a file in the first place.
 *
 * Server component: it loads the owner's snippets and hands them to the client
 * view for sharing, revoking and deleting.
 */

import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { listSnippetsForOwner } from "@/lib/snippet-service";
import { SnippetsView, type SnippetRow } from "./snippets-view";

export const dynamic = "force-dynamic";

export default async function SnippetsPage() {
    const user = await requirePermission("snippets.read");
    const snippets = await listSnippetsForOwner(user.id);
    const rows: SnippetRow[] = snippets.map((snippet) => ({
        id: snippet.id,
        title: snippet.title,
        description: snippet.description,
        visibility: snippet.visibility,
        clientSealed: snippet.clientSealed,
        burnAfterRead: snippet.burnAfterRead,
        maxViews: snippet.maxViews,
        viewCount: snippet.viewCount,
        expiresAt: snippet.expiresAt ? snippet.expiresAt.toISOString() : null,
        revokedAt: snippet.revokedAt ? snippet.revokedAt.toISOString() : null,
        updatedAt: snippet.updatedAt.toISOString(),
        canReveal: snippet.encryptedToken !== null,
        files: snippet.files.map((file) => ({
            name: file.name,
            language: file.language,
            size: file.size
        }))
    }));

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">Snippets</h1>
                    <p className="text-sm text-muted-foreground">
                        Text you can hand out by link, with the same limits as a shared file.
                    </p>
                </div>
                <Button asChild size="sm">
                    <Link href="/drive/snippets/new">
                        <Plus className="size-4" />
                        New snippet
                    </Link>
                </Button>
            </div>
            <SnippetsView snippets={rows} />
        </div>
    );
}
