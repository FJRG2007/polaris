"use client";

/**
 * The side panel: the box on the right of every player's screen, written by
 * Polaris and kept current - who is online, who is in the call of a chat group,
 * anything the server's own variables can say.
 *
 * Checked as it is typed with the rules the save uses (`sidebar.ts`), and
 * previewed with sample values. Only the server's variables are offered: the
 * panel is the same for everybody, so nothing of one player's can go on it.
 */

import * as mc from "../../lib/minecraft/motd";
import { McLine } from "../../components/mc-text";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { previewText } from "../../lib/minecraft/text-vars";
import { FieldNote, insertsFor } from "./minecraft-announce";
import { Button, Card, CardBody, Select, Switch } from "@polaris/ui";
import { FormattedTextField } from "../../components/formatted-text-field";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
    DEFAULT_SIDEBAR,
    SIDEBAR_LINES_MAX,
    SIDEBAR_LINE_MAX,
    SIDEBAR_TITLE_MAX,
    sidebarProblems,
    type SidebarConfig
} from "../../lib/minecraft/sidebar";
import {
    readLiveDisplayAction,
    saveLiveDisplayAction,
    type LiveDisplayState
} from "./live-display-actions";

/** "No group" as a select value: an empty value reads as nothing chosen. */
const NO_GROUP = "none";

export function MinecraftSidebar({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const [state, setState] = useState<LiveDisplayState | null>(null);
    const [draft, setDraft] = useState<SidebarConfig>(DEFAULT_SIDEBAR);
    const [group, setGroup] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback((next: LiveDisplayState) => {
        setState(next);
        setDraft(next.sidebar);
        setGroup(next.callGroupId);
    }, []);

    useEffect(() => {
        void readLiveDisplayAction(installedAppId).then((answer) => {
            if (answer.state) load(answer.state);
            else setError(answer.error ?? "The panel could not be read");
        });
    }, [installedAppId, load]);

    const problems = useMemo(() => sidebarProblems(draft), [draft]);
    const invalid = Boolean(
        problems.title || problems.count || problems.lines.some((line) => line !== null)
    );
    // Only a change is worth a save: the same panel saved again is a round trip
    // that changes nothing on anybody's screen.
    const dirty =
        state !== null &&
        (JSON.stringify(draft) !== JSON.stringify(state.sidebar) || group !== state.callGroupId);
    const inserts = useMemo(() => insertsFor("java", "server"), []);

    const change = (patch: Partial<SidebarConfig>) => {
        setDraft((current) => ({ ...current, ...patch }));
        setNote(null);
    };
    const setLine = (index: number, value: string) =>
        change({ lines: draft.lines.map((line, at) => (at === index ? value : line)) });

    function save(): void {
        setError(null);
        startTransition(async () => {
            const result = await saveLiveDisplayAction({
                installedAppId,
                sidebar: { ...draft, lines: [...draft.lines] },
                callGroupId: group
            });
            if (result.error || !result.state) {
                setError(result.error ?? "That could not be saved");
                return;
            }
            load(result.state);
            setNote(
                result.state.sidebar.enabled ? "On every screen now." : "Saved. The panel is off."
            );
        });
    }

    if (!state) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <p className="text-sm font-medium">Side panel</p>
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : (
                        <div className="h-24 animate-pulse rounded-md bg-muted" />
                    )}
                </CardBody>
            </Card>
        );
    }

    const refused = state.sidebarRefusal;
    return (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card>
                <CardBody className="flex flex-col gap-4">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-sm font-medium">Side panel</p>
                            <p className="text-xs text-muted-foreground">
                                A box on the right of every player&apos;s screen. Polaris keeps its
                                values current while the server runs.
                            </p>
                        </div>
                        <Switch
                            checked={draft.enabled}
                            disabled={!canManage || (refused !== null && !draft.enabled)}
                            onChange={(enabled) => change({ enabled })}
                            aria-label="Show the side panel"
                        />
                    </div>
                    {refused && <p className="text-xs text-muted-foreground">{refused}.</p>}

                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">Title</span>
                        <FormattedTextField
                            value={draft.title}
                            onChange={(title) => change({ title })}
                            rows={1}
                            singleLine
                            label="Side panel title"
                            inserts={inserts}
                            footnote={
                                <FieldNote
                                    text={draft.title}
                                    max={SIDEBAR_TITLE_MAX}
                                    problem={problems.title}
                                />
                            }
                        />
                    </div>

                    <div className="flex flex-col gap-3">
                        <span className="flex items-baseline gap-2">
                            <span className="text-sm font-medium">Lines</span>
                            <span className="text-xs text-muted-foreground">
                                {draft.lines.length}/{SIDEBAR_LINES_MAX}
                            </span>
                        </span>
                        {draft.lines.map((line, index) => (
                            <div key={index} className="flex items-start gap-1">
                                <div className="min-w-0 flex-1">
                                    <FormattedTextField
                                        value={line}
                                        onChange={(value) => setLine(index, value)}
                                        rows={1}
                                        singleLine
                                        label={`Line ${index + 1}`}
                                        placeholder="Leave empty for a gap"
                                        inserts={inserts}
                                        footnote={
                                            <FieldNote
                                                text={line}
                                                max={SIDEBAR_LINE_MAX}
                                                problem={problems.lines[index] ?? undefined}
                                            />
                                        }
                                    />
                                </div>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() =>
                                        change({
                                            lines: draft.lines.filter((_, at) => at !== index)
                                        })
                                    }
                                    aria-label={`Remove line ${index + 1}`}
                                    title={`Remove line ${index + 1}`}
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </div>
                        ))}
                        {problems.count && (
                            <p role="alert" className="text-xs text-danger">
                                {problems.count}
                            </p>
                        )}
                        <Button
                            variant="secondary"
                            size="sm"
                            className="self-start"
                            disabled={draft.lines.length >= SIDEBAR_LINES_MAX}
                            onClick={() => change({ lines: [...draft.lines, ""] })}
                        >
                            <Plus className="size-4" /> Add a line
                        </Button>
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Chat group for {"{call.*}"}</span>
                        <Select
                            value={group ?? NO_GROUP}
                            onValueChange={(value) => {
                                setGroup(value === NO_GROUP ? null : value);
                                setNote(null);
                            }}
                            options={[
                                { value: NO_GROUP, label: "None" },
                                ...state.groups.map((one) => ({ value: one.id, label: one.name }))
                            ]}
                            aria-label="Chat group whose call is shown"
                        />
                        <span className="text-xs text-muted-foreground">
                            {state.groups.length === 0
                                ? "You are in no chat group yet. Create one in Chat to show who is in its call."
                                : "Whose call {call.count} and {call.members} read, here and in announcements."}
                        </span>
                    </label>

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                            {note ??
                                (canManage
                                    ? ""
                                    : "Only somebody who manages this server can change it.")}
                        </span>
                        <Button
                            disabled={!canManage || pending || invalid || !dirty}
                            onClick={save}
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Save
                        </Button>
                    </div>
                </CardBody>
            </Card>

            <SidebarPreview sidebar={draft} />
        </div>
    );
}

/** The panel as it will read, every value at a sample. */
function SidebarPreview({ sidebar }: { sidebar: SidebarConfig }) {
    const title = mc.motdSpans(previewText(sidebar.title))[0] ?? [];
    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <p className="text-sm font-medium">Preview</p>
                <div className="flex min-h-40 justify-end rounded-md bg-[#6b8f4e] p-3">
                    <div
                        className="self-center bg-black/40 px-2 py-1 font-mono text-[13px] leading-5 text-white"
                        aria-label="Preview of the side panel"
                    >
                        <div className="text-center">
                            <McLine spans={title} />
                        </div>
                        {sidebar.lines.map((line, index) => (
                            <div key={index} className="min-h-5 whitespace-pre">
                                <McLine spans={mc.motdSpans(previewText(line))[0] ?? []} />
                            </div>
                        ))}
                    </div>
                </div>
                {!sidebar.enabled && (
                    <p className="text-xs text-muted-foreground">
                        Off: nobody sees it until it is switched on.
                    </p>
                )}
            </CardBody>
        </Card>
    );
}
