"use client";

/**
 * The teams and roles a private channel is opened to as it is made, beside the
 * people picked one by one.
 *
 * The same groups a channel's Share dialog offers - its space's organization's
 * teams and roles, or the creator's own organizations for a space no
 * organization owns - read once when the private switch is turned on and
 * filtered here, since an organization's teams and roles are a short list.
 * Each one picked becomes a member grant on the channel, the same row Share
 * writes.
 */

import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Loader2, Search, ShieldCheck, Users, X } from "lucide-react";
import { channelGroupCandidatesAction, type ChannelGroupCandidate } from "./actions";

/** A team or role picked for the channel. */
export interface PickedGroup {
    readonly type: "team" | "role";
    readonly id: string;
    readonly name: string;
}

export function ChannelGroupPicker({
    spaceId,
    picked,
    onChange
}: {
    spaceId: string;
    picked: readonly PickedGroup[];
    onChange: (picked: readonly PickedGroup[]) => void;
}) {
    const t = useTranslations("chat");
    const [candidates, setCandidates] = useState<readonly ChannelGroupCandidate[] | null>(null);
    const [failed, setFailed] = useState("");
    const [query, setQuery] = useState("");

    useEffect(() => {
        let live = true;
        setCandidates(null);
        setFailed("");
        void channelGroupCandidatesAction(spaceId)
            .then((answer) => {
                if (!live) return;
                if (answer.error) setFailed(answer.error);
                setCandidates(answer.groups ?? []);
            })
            .catch(() => {
                if (!live) return;
                setFailed(t("newChannel.groupsNotLoaded"));
                setCandidates([]);
            });
        return () => {
            live = false;
        };
    }, [spaceId, t]);

    // Nothing to offer is not worth a field: a space with no organization
    // behind it and a creator on none has no teams or roles to open it to.
    if (candidates !== null && candidates.length === 0 && !failed) return null;

    const taken = new Set(picked.map((group) => `${group.type}:${group.id}`));
    const term = query.trim().toLowerCase();
    const offered = (candidates ?? []).filter(
        (group) =>
            !taken.has(`${group.type}:${group.id}`) &&
            (term === "" || group.name.toLowerCase().includes(term))
    );

    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">{t("newChannel.teamsAndRoles")}</p>
            {picked.length > 0 && (
                <ul className="flex flex-wrap gap-1">
                    {picked.map((group) => (
                        <li
                            key={`${group.type}:${group.id}`}
                            className="flex min-w-0 items-center gap-1 rounded-full bg-muted py-0.5 ps-1.5 pe-1.5 text-xs"
                        >
                            <GroupIcon type={group.type} />
                            <span className="max-w-[10rem] truncate" title={group.name}>
                                {group.name}
                            </span>
                            <button
                                type="button"
                                aria-label={t("newChannel.removeGroup", { name: group.name })}
                                onClick={() =>
                                    onChange(
                                        picked.filter(
                                            (entry) => !(entry.type === group.type && entry.id === group.id)
                                        )
                                    )
                                }
                                className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <X className="size-3" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="relative">
                <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("newChannel.findTeamOrRole")}
                    aria-label={t("newChannel.teamsAndRoles")}
                    className="h-8 w-full rounded-md border border-border bg-field ps-7 pe-7 text-sm hover:border-border-strong focus:border-border-strong"
                />
                {candidates === null && (
                    <Loader2 className="absolute end-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
            </div>
            {failed ? (
                <p className="px-2 text-xs text-danger">{failed}</p>
            ) : (
                candidates !== null && (
                    <ul className="max-h-40 overflow-y-auto overscroll-contain">
                        {offered.length === 0 ? (
                            <li className="px-2 py-2 text-xs text-muted-foreground">
                                {t("newChannel.noTeamOrRole")}
                            </li>
                        ) : (
                            offered.map((group) => (
                                <li key={`${group.type}:${group.id}`}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setQuery("");
                                            onChange([
                                                ...picked,
                                                { type: group.type, id: group.id, name: group.name }
                                            ]);
                                        }}
                                        className={cn(
                                            "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-card-hover"
                                        )}
                                    >
                                        <GroupIcon type={group.type} />
                                        <span className="flex min-w-0 flex-1 flex-col">
                                            <span className="truncate" title={group.name}>
                                                {group.name}
                                            </span>
                                            <span className="truncate text-xs text-muted-foreground" title={group.orgName}>
                                                {group.type === "team"
                                                    ? t("newChannel.teamIn", { org: group.orgName })
                                                    : t("newChannel.roleIn", { org: group.orgName })}
                                            </span>
                                        </span>
                                    </button>
                                </li>
                            ))
                        )}
                    </ul>
                )
            )}
        </div>
    );
}

function GroupIcon({ type }: { type: PickedGroup["type"] }) {
    const Icon = type === "team" ? Users : ShieldCheck;
    return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}
