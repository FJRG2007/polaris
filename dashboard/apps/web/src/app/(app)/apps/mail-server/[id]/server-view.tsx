"use client";

/**
 * One mail server: a header, a row of tabs, and the tab's panel. The tab is in
 * the address (`?tab=`) so a notification can open the panel it is about.
 */

import Link from "next/link";
import { DnsTab } from "./dns-tab";
import { RulesTab } from "./rules-tab";
import { ArrowLeft } from "lucide-react";
import { BackupsTab } from "./backups-tab";
import { ReportsTab } from "./reports-tab";
import { SendingTab } from "./sending-tab";
import { OverviewTab } from "./overview-tab";
import { ForwardsTab } from "./forwards-tab";
import { MailboxesTab } from "./mailboxes-tab";
import { Card, CardBody, cn, ScrollRow } from "@polaris/ui";
import { useRouter, useSearchParams } from "next/navigation";

const TABS = [
    { id: "overview", label: "Overview" },
    { id: "domains", label: "Domains and DNS" },
    { id: "mailboxes", label: "Mailboxes" },
    { id: "forwards", label: "Forwards" },
    { id: "sending", label: "Sending" },
    { id: "rules", label: "Rules" },
    { id: "reports", label: "DMARC reports" },
    { id: "backups", label: "Backups" }
] as const;

type TabId = (typeof TABS)[number]["id"];

export function ServerView({ serverId, hostname }: { serverId: string; hostname: string }) {
    const router = useRouter();
    const params = useSearchParams();
    const asked = params.get("tab");
    const tab: TabId = TABS.some((entry) => entry.id === asked) ? (asked as TabId) : "overview";

    function choose(next: TabId): void {
        const query = new URLSearchParams(params.toString());
        if (next === "overview") query.delete("tab");
        else query.set("tab", next);
        const search = query.toString();
        router.replace(`/apps/mail-server/${serverId}${search ? `?${search}` : ""}`, {
            scroll: false
        });
    }

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
            <div className="flex items-center gap-2">
                <Link
                    href="/apps/mail-server"
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="All mail servers"
                    title="All mail servers"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                <h1
                    className="min-w-0 truncate text-[17px] font-semibold tracking-tight text-foreground"
                    title={hostname}
                >
                    {hostname}
                </h1>
            </div>
            <Card>
                <ScrollRow className="flex gap-1 border-b border-border px-2 py-2" role="tablist">
                    {TABS.map((entry) => (
                        <button
                            key={entry.id}
                            type="button"
                            role="tab"
                            aria-selected={tab === entry.id}
                            onClick={() => choose(entry.id)}
                            className={cn(
                                "shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-muted",
                                tab === entry.id
                                    ? "bg-muted font-medium text-foreground"
                                    : "text-muted-foreground"
                            )}
                        >
                            {entry.label}
                        </button>
                    ))}
                </ScrollRow>
                <CardBody className="min-h-[24rem]">
                    {tab === "overview" ? <OverviewTab serverId={serverId} /> : null}
                    {tab === "domains" ? <DnsTab serverId={serverId} /> : null}
                    {tab === "mailboxes" ? <MailboxesTab serverId={serverId} /> : null}
                    {tab === "forwards" ? <ForwardsTab serverId={serverId} /> : null}
                    {tab === "sending" ? <SendingTab serverId={serverId} /> : null}
                    {tab === "rules" ? <RulesTab serverId={serverId} /> : null}
                    {tab === "reports" ? <ReportsTab serverId={serverId} /> : null}
                    {tab === "backups" ? <BackupsTab serverId={serverId} /> : null}
                </CardBody>
            </Card>
        </div>
    );
}
