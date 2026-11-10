"use client";

/**
 * Who can reach one thing in Tasks.
 *
 * This is the share dialog every other thing in Polaris is handed over with -
 * one box for people, teams and roles, "People with access" with a role on
 * every row - on subject `task.space` or `task.folder`. Grants are written to
 * AccessGrant and nowhere else, so what the dialog removes is gone; see
 * `lib/tasks/access.ts`, which reads nothing but those grants.
 *
 * Grants live at two levels. A space is the whole of somebody's work; a folder
 * is the branch that makes nesting worth having - a client gets their own folder
 * and sees that folder, not the space it happens to live in. The rest of the
 * tree has no grants of its own: a list is reached through the folder it sits
 * in, or through the space when it sits in none, and a sprint plans a folder's
 * work and is reached the same way. So a right-click on one of those opens this
 * on the level that governs it, with a line naming what was asked about and what
 * is actually being changed - read before anything else, which is why it is the
 * share dialog's `notice` rather than its `extra`.
 *
 * What the share dialog cannot know is Tasks' own: grants made further up reach
 * this folder too. They are listed under the grants, read-only and named by
 * where they were made, because the alternative is somebody reading an empty
 * list and re-inviting a person who is already here through the folder above.
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import { optionLabel } from "./option-label";
import { Shield, Users } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { ShareDialog } from "@/components/access/share-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { InheritedGrantView } from "@/lib/tasks/space-service";

/** Where the grants being edited actually live. */
export type AccessScope = { kind: "space"; id: string } | { kind: "folder"; id: string };

/** What the reader right-clicked, when that is not the scope itself. */
export interface AccessAsked {
    kind: "list" | "sprint";
    name: string;
}

export interface AccessTarget {
    readonly scope: AccessScope;
    readonly asked?: AccessAsked;
}

interface AccessDetail {
    name: string;
    path: string;
    inherited: InheritedGrantView[];
}

export function AccessDialog({
    target,
    onClose
}: {
    target: AccessTarget | null;
    onClose: () => void;
}) {
    const t = useTranslations("tasks");
    const [detail, setDetail] = useState<AccessDetail | null>(null);
    const [error, setError] = useState("");

    // The two ids the effect depends on, as values rather than as an object that
    // is a new one on every render.
    const scopeKind = target?.scope.kind ?? "space";
    const scopeId = target?.scope.id ?? "";
    const whole = scopeKind === "space";

    useEffect(() => {
        setDetail(null);
        setError("");
        if (!scopeId) return;
        let live = true;
        void actions
            .accessDetailAction(scopeKind, scopeId)
            .then((answer) => {
                if (!live) return;
                if (answer.error) setError(answer.error);
                else
                    setDetail({
                        name: answer.name ?? "",
                        path: answer.path ?? "",
                        inherited: answer.inherited ?? []
                    });
            })
            .catch(() => {
                if (live) setError(t("errors.readAccess"));
            });
        return () => {
            live = false;
        };
        // `t` is left out on purpose: a language change is no reason to read
        // the same space again.
    }, [scopeKind, scopeId]);

    if (!target) return null;

    const notice = (
        <>
            {detail?.path ? (
                <span className="block truncate font-mono text-xs" title={detail.path}>
                    {detail.path}
                </span>
            ) : null}
            {/* Named before the reach, because somebody who came here from a
                list has to read that they are about to change something larger
                before they read what it does. */}
            {target.asked ? (
                <span className="block">
                    {t.rich("access.inherited", {
                        kind: target.asked.kind,
                        scope: whole ? "space" : "folder",
                        name: target.asked.name,
                        strong: (chunks) => (
                            <strong key="name" className="font-medium text-foreground">
                                {chunks}
                            </strong>
                        )
                    })}
                </span>
            ) : null}
            <span className="block">
                {whole ? t("access.reachSpace") : t("access.reachFolder")}
            </span>
            {error ? (
                <span role="alert" className="block text-danger-ink">
                    {error}
                </span>
            ) : null}
        </>
    );

    const inherited = detail?.inherited ?? [];
    const extra =
        inherited.length > 0 ? (
            <section
                className="flex min-w-0 flex-col gap-1"
                aria-label={t("access.fromAbove")}
            >
                <h3 className="truncate text-[13px] font-medium text-foreground">
                    {t("access.fromAbove")}
                </h3>
                <ul className="flex max-h-60 min-w-0 flex-col overflow-y-auto overscroll-contain">
                    {inherited.map((grant) => (
                        <li
                            key={`${grant.principalType}:${grant.principalId}:${grant.through}`}
                            className="flex min-h-14 min-w-0 items-center gap-3 px-1 py-1 opacity-80"
                        >
                            <InheritedFace grant={grant} />
                            <div className="min-w-0 flex-1">
                                <p
                                    className="truncate text-[13px] text-foreground"
                                    title={grant.name}
                                >
                                    {grant.name}
                                </p>
                                <p className="truncate text-[12px] text-muted-foreground">
                                    {t("access.through", { name: grant.through })}
                                </p>
                            </div>
                            <span className="shrink-0 text-[12px] text-muted-foreground">
                                {optionLabel(t, "spaceRole", grant.capability)}
                            </span>
                        </li>
                    ))}
                </ul>
            </section>
        ) : null;

    return (
        <ShareDialog
            open
            onOpenChange={(open) => (open ? undefined : onClose())}
            subject={whole ? "task.space" : "task.folder"}
            subjectId={scopeId}
            name={detail?.name || (whole ? t("access.thisSpace") : t("access.thisFolder"))}
            notice={notice}
            extra={extra}
        />
    );
}

/** The same 32px disc the share dialog's own rows use, so both lists line up. */
function InheritedFace({ grant }: { grant: InheritedGrantView }) {
    if (grant.principalType === "user") {
        return (
            <Avatar
                person={{ id: grant.principalId, name: grant.name }}
                size={32}
                status={false}
                lazy
            />
        );
    }
    const Icon = grant.principalType === "team" ? Users : Shield;
    return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground-subtle">
            <Icon className="size-4 shrink-0" aria-hidden />
        </span>
    );
}
