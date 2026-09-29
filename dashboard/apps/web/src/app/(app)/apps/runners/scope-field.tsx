"use client";

/**
 * Saying what a pool serves.
 *
 * The six answers have almost nothing in common - one takes a repository, one
 * takes a list of them, one takes an account name, two take Polaris people - so
 * this is a picker per kind behind one control rather than a form that shows every
 * field and disables most of them.
 *
 * Whatever is chosen, the number it comes to is looked up and shown. A scope that
 * names an account is a promise about repositories nobody has listed yet, and
 * "serves 34 repositories" is the difference between a considered choice and a
 * surprise on somebody's build machine.
 */

import { Loader2, X } from "lucide-react";
import type { RunnerScopeInput } from "@polaris/core";
import { RepoPicker } from "@/components/repo-picker";
import { Badge, Checkbox, Input, Select } from "@polaris/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    githubReposAction,
    previewScopeAction,
    runnerPrincipalsAction,
    searchGithubReposAction
} from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";

/** The kinds of scope, each said as `scopeField.kinds.<kind>`. */
const SCOPE_KINDS = ["repo", "repos", "account", "org", "users", "group"] as const;

interface Principals {
    people: Array<{ userId: string; name: string; login: string }>;
    groups: Array<{ id: string; name: string; linked: number }>;
}

/** How long to wait after the last keystroke before re-resolving a scope. */
const PREVIEW_DEBOUNCE_MS = 350;

export interface ScopeState {
    kind: RunnerScopeInput["kind"];
    repos: string[];
    owner: string;
    userIds: string[];
    groupId: string;
}

export const EMPTY_SCOPE: ScopeState = {
    kind: "repo",
    repos: [],
    owner: "",
    userIds: [],
    groupId: ""
};

/** The scope as the schema wants it, or null when it is not answerable yet. */
export function toScope(state: ScopeState): RunnerScopeInput | null {
    const split = (full: string) => {
        const [owner, repo] = full.split("/");
        return owner && repo ? { owner, repo } : null;
    };
    switch (state.kind) {
        case "repo": {
            const first = state.repos[0] ? split(state.repos[0]) : null;
            return first ? { kind: "repo", ...first } : null;
        }
        case "repos": {
            const repos = state.repos
                .map(split)
                .filter((entry): entry is { owner: string; repo: string } => entry !== null);
            return repos.length > 0 ? { kind: "repos", repos } : null;
        }
        case "account":
            return state.owner.trim() ? { kind: "account", owner: state.owner.trim() } : null;
        case "org":
            return state.owner.trim() ? { kind: "org", owner: state.owner.trim() } : null;
        case "users":
            return state.userIds.length > 0 ? { kind: "users", userIds: state.userIds } : null;
        case "group":
            return state.groupId ? { kind: "group", groupId: state.groupId } : null;
    }
}

export function ScopeField({
    state,
    onChange,
    onPreview
}: {
    state: ScopeState;
    onChange: (next: ScopeState) => void;
    /** Told what the scope resolves to, so the dialog can refuse to submit one
     *  that serves nothing. */
    onPreview: (result: { count: number; note: string | null }) => void;
}) {
    const t = useTranslations("runners");
    const [connected, setConnected] = useState(true);
    const [principals, setPrincipals] = useState<Principals | null>(null);
    const [preview, setPreview] = useState<{ count: number; note: string | null } | null>(null);
    const [checking, setChecking] = useState(false);

    const needsRepos = state.kind === "repo" || state.kind === "repos";
    const needsPeople = state.kind === "users" || state.kind === "group";

    // Whether the account is connected decides one line of copy here, so it is
    // read alongside the picker's own load rather than in a second call.
    const listRepos = useCallback(async () => {
        const result = await githubReposAction();
        setConnected(result.connected);
        return result;
    }, []);

    useEffect(() => {
        if (!needsPeople) return;
        void runnerPrincipalsAction()
            .then(setPrincipals)
            .catch(() => undefined);
    }, [needsPeople]);

    // What it comes to, asked for whenever the answer would change. Debounced,
    // because an account name is resolved as it is typed and every keystroke would
    // otherwise be a call to GitHub.
    const scope = useMemo(() => toScope(state), [state]);
    const serialized = scope === null ? "" : JSON.stringify(scope);
    useEffect(() => {
        if (!serialized) {
            setPreview(null);
            onPreview({ count: 0, note: null });
            return;
        }
        let live = true;
        setChecking(true);
        const timer = setTimeout(() => {
            void previewScopeAction(JSON.parse(serialized))
                .then((result) => {
                    if (!live) return;
                    const next = {
                        count: result.targets?.length ?? 0,
                        note: result.note ?? result.error ?? null
                    };
                    setPreview(next);
                    onPreview(next);
                })
                .catch(() => undefined)
                .finally(() => {
                    if (live) setChecking(false);
                });
        }, PREVIEW_DEBOUNCE_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
        // onPreview is a callback the parent recreates each render; depending on it
        // would re-run this on every keystroke of an unrelated field.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serialized]);

    const pick = useCallback(
        (fullName: string) => {
            if (state.kind === "repo") {
                onChange({ ...state, repos: [fullName] });
                return;
            }
            if (state.repos.includes(fullName)) return;
            onChange({ ...state, repos: [...state.repos, fullName] });
        },
        [state, onChange]
    );

    return (
        <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-sm">
                {t("scopeField.serve")}
                <Select
                    value={state.kind}
                    onValueChange={(value) =>
                        onChange({ ...EMPTY_SCOPE, kind: value as RunnerScopeInput["kind"] })
                    }
                    options={SCOPE_KINDS.map((kind) => ({
                        value: kind,
                        label: t(`scopeField.kinds.${kind}` as NamespaceKey<"runners">)
                    }))}
                />
            </label>

            {needsRepos ? (
                <div className="flex flex-col gap-2">
                    {state.repos.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                            {state.repos.map((full) => (
                                <Badge key={full} variant="neutral" className="gap-1">
                                    {full}
                                    <button
                                        type="button"
                                        aria-label={t("pools.removeNamed", { name: full })}
                                        title={t("pools.remove")}
                                        onClick={() =>
                                            onChange({
                                                ...state,
                                                repos: state.repos.filter((entry) => entry !== full)
                                            })
                                        }
                                    >
                                        <X className="size-3" />
                                    </button>
                                </Badge>
                            ))}
                        </div>
                    ) : null}

                    {state.kind === "repos" || state.repos.length === 0 ? (
                        <>
                            <RepoPicker
                                cacheKey="runners"
                                list={listRepos}
                                search={searchGithubReposAction}
                                onPick={(repo) => pick(repo.fullName)}
                                selected={state.repos}
                                placeholder={t("scopeField.repoPlaceholder")}
                                maxHeightClass="max-h-40"
                            />
                            {!connected ? (
                                <Hint>{t("scopeField.notConnected")}</Hint>
                            ) : null}
                        </>
                    ) : null}
                </div>
            ) : null}

            {state.kind === "account" || state.kind === "org" ? (
                <label className="flex flex-col gap-1 text-sm">
                    {state.kind === "org" ? t("scopeField.organization") : t("scopeField.account")}
                    <Input
                        value={state.owner}
                        onChange={(event) => onChange({ ...state, owner: event.target.value })}
                        placeholder="acme" // i18n-ignore an example account name
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                    />
                    <Hint>
                        {state.kind === "org" ? t("scopeField.orgHint") : t("scopeField.accountHint")}
                    </Hint>
                </label>
            ) : null}

            {state.kind === "users" ? (
                <div className="flex flex-col gap-1 text-sm">
                    {t("scopeField.people")}
                    {principals === null ? (
                        <Hint>{t("scopeField.lookingPeople")}</Hint>
                    ) : principals.people.length === 0 ? (
                        <Hint>{t("scopeField.nobodyLinked")}</Hint>
                    ) : (
                        <ul className="max-h-40 overflow-y-auto overscroll-contain rounded-md border border-border/60">
                            {principals.people.map((person) => (
                                <li
                                    key={person.userId}
                                    className="flex items-center gap-2 px-3 py-1.5"
                                >
                                    <Checkbox
                                        checked={state.userIds.includes(person.userId)}
                                        onChange={(event) =>
                                            onChange({
                                                ...state,
                                                userIds: event.target.checked
                                                    ? [...state.userIds, person.userId]
                                                    : state.userIds.filter(
                                                          (id) => id !== person.userId
                                                      )
                                            })
                                        }
                                    />
                                    <span className="min-w-0 flex-1 truncate">{person.name}</span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {person.login}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            ) : null}

            {state.kind === "group" ? (
                <label className="flex flex-col gap-1 text-sm">
                    {t("scopeField.group")}
                    {principals === null ? (
                        <Hint>{t("scopeField.lookingGroups")}</Hint>
                    ) : (
                        <Select
                            value={state.groupId}
                            onValueChange={(value) => onChange({ ...state, groupId: value })}
                            placeholder={t("schema.pickGroup")}
                            options={principals.groups.map((group) => ({
                                value: group.id,
                                label: t("scopeField.groupLinked", { name: group.name, count: group.linked })
                            }))}
                        />
                    )}
                    <Hint>{t("scopeField.groupHint")}</Hint>
                </label>
            ) : null}

            <ScopePreview checking={checking} preview={preview} />
        </div>
    );
}

function ScopePreview({
    checking,
    preview
}: {
    checking: boolean;
    preview: { count: number; note: string | null } | null;
}) {
    const t = useTranslations("runners");
    if (checking) {
        return (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> {t("scopeField.working")}
            </span>
        );
    }
    if (!preview) return null;
    if (preview.note) return <span className="text-xs text-danger">{preview.note}</span>;
    if (preview.count === 0) return null;
    return (
        <Hint>{t("scopeField.serves", { count: preview.count })}</Hint>
    );
}

function Hint({ children }: { children: React.ReactNode }) {
    return <span className="text-xs text-muted-foreground">{children}</span>;
}
