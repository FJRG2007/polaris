/**
 * The front page of Tools: what you have, rather than what you wanted to do.
 *
 * Four cards, because the jobs behind them share their halves - the thing that
 * resizes a picture is the thing that optimizes it, and both are the same upload
 * as the one that reads its metadata. Somebody arriving with a file in their
 * hand picks the kind of file, and everything that can be done to it is on the
 * screen that opens.
 */

import Link from "next/link";
import { PageHeader } from "@polaris/ui";
import { TOOL_GROUPS } from "@/lib/tools/catalog";
import { requireToolsReach } from "@/lib/tools/access";

export const dynamic = "force-dynamic";

export default async function ToolsPage() {
    await requireToolsReach();

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <PageHeader
                title="Tools"
                description="The small jobs, done here instead of on somebody else's server."
            />

            <ul className="grid gap-3 sm:grid-cols-2">
                {TOOL_GROUPS.map((group) => (
                    <li key={group.id}>
                        <Link
                            href={group.soon ? "/tools" : group.href}
                            aria-disabled={group.soon}
                            className={
                                group.soon
                                    ? "pointer-events-none flex h-full flex-col gap-3 rounded-lg border border-border p-4 opacity-60"
                                    : "flex h-full flex-col gap-3 rounded-lg border border-border p-4 transition-colors hover:border-primary hover:bg-surface"
                            }
                        >
                            <div className="flex items-center gap-2">
                                <group.icon
                                    className="size-5 shrink-0 text-foreground-subtle"
                                    aria-hidden
                                />
                                <span className="font-medium">{group.name}</span>
                                {group.soon ? (
                                    <span className="ml-auto rounded border border-border px-1.5 py-0.5 text-xs text-foreground-subtle">
                                        Coming
                                    </span>
                                ) : null}
                            </div>
                            <ul className="flex flex-col gap-1 text-sm text-foreground-subtle">
                                {group.does.map((one) => (
                                    <li key={one}>{one}</li>
                                ))}
                            </ul>
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}
