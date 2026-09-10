/**
 * The capabilities, a group at a time: the group's number, name and summary in a
 * rail that stays in view while its cards scroll past, and a card per thing with
 * a link to where it is done.
 *
 * A screen this reader cannot open is named without a link rather than hidden,
 * so the page still says what Polaris does - and a link that would only turn
 * them away is not offered.
 */

import Link from "next/link";
import { ScrollRow } from "@polaris/ui";
import { ArrowRight } from "lucide-react";
import type { Capability, CapabilityGroup } from "@/lib/deploy/capabilities";

export type ReachableGroup = Omit<CapabilityGroup, "items"> & { items: (Capability & { open: boolean })[] };

function number(index: number): string {
    return String(index + 1).padStart(2, "0");
}

export function CapabilitiesView({ groups }: { groups: readonly ReachableGroup[] }) {
    const total = groups.reduce((sum, group) => sum + group.items.length, 0);
    return (
        <div className="flex w-full flex-col gap-6">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Capabilities</h1>
                <p className="text-sm text-muted-foreground">
                    What Polaris does for what you deploy - {total} things in {groups.length} groups - and where
                    each one is.
                </p>
            </div>

            <nav aria-label="Capability groups">
                <ScrollRow as="ul" className="-mx-1 flex gap-1 px-1 pb-1">
                    {groups.map((group, index) => (
                        <li key={group.id} className="shrink-0">
                            <a
                                href={`#${group.id}`}
                                className="flex items-center gap-2 whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <span className="font-mono text-xs tabular-nums text-foreground-subtle">
                                    {number(index)}
                                </span>
                                {group.title}
                            </a>
                        </li>
                    ))}
                </ScrollRow>
            </nav>

            {groups.map((group, index) => (
                <section
                    key={group.id}
                    id={group.id}
                    aria-labelledby={`${group.id}-title`}
                    className="grid scroll-mt-4 gap-4 border-t border-border pt-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8"
                >
                    <header className="lg:sticky lg:top-4 lg:self-start">
                        <span className="font-mono text-xs tabular-nums text-foreground-subtle">{number(index)}</span>
                        <h2 id={`${group.id}-title`} className="mt-1 text-base font-semibold tracking-tight">
                            {group.title}
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">{group.summary}</p>
                    </header>
                    <ul className="grid gap-3 sm:grid-cols-2">
                        {group.items.map((item) => (
                            <li key={item.title} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
                                <h3 className="text-sm font-medium text-foreground">{item.title}</h3>
                                <p className="flex-1 text-[0.8125rem] leading-relaxed text-muted-foreground">
                                    {item.description}
                                </p>
                                {item.open ? (
                                    <Link
                                        href={item.href}
                                        className="inline-flex items-center gap-1 self-start rounded text-xs font-medium text-primary hover:underline"
                                    >
                                        {item.where}
                                        <ArrowRight className="size-3" />
                                    </Link>
                                ) : (
                                    <span className="text-xs text-foreground-subtle">{item.where} - not open to you</span>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}
