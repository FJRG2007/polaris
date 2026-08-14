/**
 * Writing a new snippet (/drive/snippets/new).
 */

import { requirePermission } from "@/lib/session";
import { SnippetEditor } from "../snippet-editor";

export const dynamic = "force-dynamic";

export default async function NewSnippetPage() {
    await requirePermission("snippets.write");

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">New snippet</h1>
                <p className="text-sm text-muted-foreground">
                    Paste the text, name the files, and share it if you want to.
                </p>
            </div>
            <SnippetEditor />
        </div>
    );
}
