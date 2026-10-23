/** Tools: the everyday utilities, by what each group does. */

import Link from "next/link";
import { PageHeader } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { TOOL_GROUPS } from "@/lib/tools/catalog";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** The page `/tools` draws, the way `tools/page.tsx` lays it out. */
function Tools() {
    const t = useTranslations("tools");
    const word = (key: string) => t(key as never);
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <PageHeader title={t("page.title")} description={t("page.description")} />
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
                                <span className="font-medium">
                                    {word(`groups.${group.id}.name`)}
                                </span>
                                {group.soon ? (
                                    <span className="ml-auto rounded border border-border px-1.5 py-0.5 text-xs text-foreground-subtle">
                                        {t("page.coming")}
                                    </span>
                                ) : null}
                            </div>
                            <ul className="flex flex-col gap-1 text-sm text-foreground-subtle">
                                {group.does.map((one, index) => (
                                    <li key={one}>{word(`groups.${group.id}.does.${index}`)}</li>
                                ))}
                            </ul>
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export const tools = defineScene({
    id: "tools",
    path: "/tools",
    render: () => (
        <Chrome>
            <Tools />
        </Chrome>
    )
});
