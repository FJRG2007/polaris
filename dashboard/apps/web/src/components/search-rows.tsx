"use client";

/**
 * The things the search panel can list, and how each is drawn.
 *
 * They are deliberately not one row with several variations. A page and a task
 * are not the same kind of answer: a page is a place that was always going to
 * be there, a task is a record that existed when the query ran and carries its
 * own handle and state. Somebody scanning the list should be able to tell which
 * half of the panel they are looking at without reading it, which is why the
 * ones that came from the database wear a face - a status colour, an avatar, a
 * reference - and the ones that came from the app registry or parsed from the
 * query itself, like a clock command, wear an icon.
 */

import { AppLogo, Badge, cn } from "@polaris/ui";
import { SearchItem } from "@polaris/ui/search-panel";
import { Avatar } from "@/components/avatar";
import type { LucideIcon } from "lucide-react";
import type { ClockCommand, RecentSearch } from "@polaris/core";
import { LAUNCHER_COMMANDS } from "@polaris/core";
import { AlarmClock, AppWindow, Calculator, Clipboard, Clock, Copy, CornerDownLeft, Globe, Power, Timer, Watch, X } from "lucide-react";
import type { HostRow, HostRowKind } from "@/lib/search/search-host";
import type { CommandEntry } from "@/lib/search/entries";
import type { SearchHit } from "@/lib/search/lookup-service";
import { PersonName, PersonRow } from "@/components/person-name";
import { scopeWords, searchScope, type SearchScopeDefinition } from "@/lib/search/scopes";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** What every row is given, whatever it draws inside. */
export interface RowProps {
    /** Pointed at by the field's `aria-activedescendant` when this row is the
     *  one the arrow keys are on. */
    id: string;
    selected: boolean;
    onSelect: () => void;
    onHover: () => void;
}

/** Shared shell: the same height, padding and highlight for every kind of row. */
function Row({
    id,
    selected,
    onSelect,
    onHover,
    children,
    label,
    personId = null,
    keepFocus = false
}: RowProps & {
    children: React.ReactNode;
    label: string;
    /** The field keeps focus through a press on the row - and a phone keeps its
     *  keyboard up - when choosing the row means going on typing. */
    keepFocus?: boolean;
    /** Whose row it is, when the answer is a person. A task, a page or a command
     *  is not somebody and passes nothing. */
    personId?: string | null;
}) {
    return (
        <PersonRow
            personId={personId}
            id={id}
            role="option"
            aria-selected={selected}
            aria-label={label}
            data-active={selected}
            onMouseMove={onHover}
            onMouseDown={keepFocus ? (event) => event.preventDefault() : undefined}
            onClick={onSelect}
            className={cn(
                "flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-start transition-colors",
                selected ? "bg-option-hover" : "hover:bg-option-hover/60"
            )}
        >
            {children}
        </PersonRow>
    );
}

/** A destination the app registry already knew about. */
export function EntryRow({ entry, ...row }: RowProps & { entry: CommandEntry }) {
    const Icon: LucideIcon = entry.icon;
    return (
        <Row {...row} label={entry.label}>
            <SearchItem
                icon={
                    <AppLogo
                        appId={entry.appId ?? ""}
                        size={18}
                        fallback={<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    />
                }
                label={entry.label}
                context={entry.context}
            />
        </Row>
    );
}

/** A command, offered while its word is being typed. */
export function CommandRow({ scope, ...row }: RowProps & { scope: SearchScopeDefinition }) {
    const Icon = scope.icon;
    const t = useTranslations("components");
    const words = scopeWords(t, scope.id);
    return (
        <Row {...row} label={t("search.scopeRow", { scope: words.label })}>
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm" title={words.placeholder}>
                    {words.placeholder}
                </span>
            </span>
            <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[0.625rem] leading-none text-muted-foreground">
                {scope.sigil ?? `/${scope.keywords[0]}`}
            </kbd>
        </Row>
    );
}

/** What a typed clock command will do, in words: "Start a 10 min timer: tea". */
export function clockCommandText(
    command: ClockCommand,
    t: ReturnType<typeof useTranslations>,
    locale: string
): string {
    if (command.kind === "stopwatch") return t("search.clock.stopwatch");
    if (command.kind === "alarm") {
        const time = new Intl.DateTimeFormat(locale, {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "UTC"
        }).format(new Date(Date.UTC(2024, 0, 1, command.hour, command.minute)));
        const said = t("search.clock.alarm", { time });
        return command.label
            ? t("search.clock.labelled", { action: said, label: command.label })
            : said;
    }
    const seconds = Math.round(command.durationMs / 1000);
    const length = [
        Math.floor(seconds / 3600)
            ? t("search.clock.hours", { count: Math.floor(seconds / 3600) })
            : "",
        Math.floor((seconds % 3600) / 60)
            ? t("search.clock.minutes", { count: Math.floor((seconds % 3600) / 60) })
            : "",
        seconds % 60 ? t("search.clock.seconds", { count: seconds % 60 }) : ""
    ]
        .filter(Boolean)
        .join(" ");
    const said = t("search.clock.timer", { length });
    return command.label
        ? t("search.clock.labelled", { action: said, label: command.label })
        : said;
}

/** The answer to a sum typed into the field; choosing it puts the answer in the
 *  field, and its own button copies it. */
export function CalculationRow({
    expression,
    answer,
    label,
    copyLabel,
    copyTitle,
    onCopy,
    ...row
}: RowProps & {
    expression: string;
    answer: string;
    label: string;
    copyLabel: string;
    copyTitle: string;
    onCopy: () => void;
}) {
    return (
        <Row {...row} label={label} keepFocus>
            <Calculator className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold tabular-nums" title={answer}>
                    = {answer}
                </span>
                <span className="block truncate text-xs text-muted-foreground" title={expression}>
                    {expression}
                </span>
            </span>
            <button
                type="button"
                title={copyTitle}
                aria-label={copyLabel}
                onClick={(event) => {
                    // The row's own action is to use the answer, not this.
                    event.stopPropagation();
                    onCopy();
                }}
                className="-my-2 flex size-10 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            >
                <Copy className="size-4" aria-hidden="true" />
            </button>
            <CornerDownLeft
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
            />
        </Row>
    );
}

/** A typed "timer 10m", "alarm 7:30" or "stopwatch", ready to run. */
export function ClockRow({
    text,
    command,
    ...row
}: RowProps & { text: string; command: ClockCommand }) {
    const Icon = command.kind === "alarm" ? AlarmClock : command.kind === "timer" ? Timer : Watch;
    return (
        <Row {...row} label={text}>
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm" title={text}>
                    {text}
                </span>
            </span>
            <CornerDownLeft
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
            />
        </Row>
    );
}

/**
 * A record that was looked up when the query ran.
 *
 * The badge, the status dot and the avatar are the whole point: these rows are
 * live data with a state of their own, not entries in a list of screens.
 */
export function HitRow({ hit, ...row }: RowProps & { hit: SearchHit }) {
    const person = hit.scope === "users" || hit.scope === "contacts";
    const personId = person ? hit.id : null;
    // A conversation, a channel or a message wears its kind, since it has no
    // face or state of its own to wear.
    const KindIcon =
        hit.scope === "chats" || hit.scope === "channels" || hit.scope === "messages"
            ? searchScope(hit.scope).icon
            : null;
    return (
        <Row {...row} label={hit.label} personId={personId}>
            {person ? (
                <Avatar
                    person={{ id: hit.id, name: hit.label, image: hit.image ?? null }}
                    size={22}
                />
            ) : KindIcon ? (
                <KindIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : hit.status ? (
                <span
                    aria-hidden="true"
                    title={hit.status.name}
                    className="size-2.5 shrink-0 rounded-full ring-2 ring-background"
                    style={{ backgroundColor: hit.status.color }}
                />
            ) : (
                <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
                />
            )}
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                    {hit.reference ? (
                        <Badge className="shrink-0 font-mono text-[0.625rem]">
                            {hit.reference}
                        </Badge>
                    ) : null}
                    <span className="min-w-0 truncate text-sm" title={hit.label}>
                        <PersonName id={personId} name={hit.label} />
                    </span>
                </span>
                {hit.detail ? (
                    <span
                        className="block truncate text-xs text-muted-foreground"
                        title={hit.detail}
                    >
                        {hit.detail}
                    </span>
                ) : null}
            </span>
            {hit.status ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                    {hit.status.name}
                </span>
            ) : null}
        </Row>
    );
}

/** Something searched before: a result to reopen, or words to run again. */
export function RecentRow({
    entry,
    scopeLabel,
    onForget,
    ...row
}: RowProps & {
    entry: RecentSearch;
    /** The command it was made under, already resolved to its name. */
    scopeLabel: string | null;
    onForget: () => void;
}) {
    const t = useTranslations("components");
    return (
        <Row {...row} label={entry.label}>
            {entry.kind === "result" ? (
                <CornerDownLeft
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                />
            ) : (
                <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm" title={entry.label}>
                {entry.label}
            </span>
            {scopeLabel ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                    {scopeLabel}
                </span>
            ) : null}
            <button
                type="button"
                title={t("search.forget")}
                aria-label={t("search.forgetNamed", { label: entry.label })}
                onClick={(event) => {
                    // The row underneath opens what it names; this only forgets it.
                    event.stopPropagation();
                    onForget();
                }}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            >
                <X className="size-3.5" aria-hidden="true" />
            </button>
        </Row>
    );
}

type Translate = ReturnType<typeof useTranslations>;

/** The system commands that ask before they run. */
const CONFIRMED = new Set<string>(LAUNCHER_COMMANDS.filter((command) => command.confirm).map((command) => command.id));

/** The heading a host's row is listed under. */
export function hostGroup(t: Translate, kind: HostRowKind): string {
    if (kind === "answer") return t("search.calculator");
    if (kind === "system") return t("search.host.system");
    if (kind === "app") return t("search.host.apps");
    if (kind === "web") return t("search.host.web");
    if (kind === "polar") return t("search.host.polar");
    return t("search.host.clip");
}

/** A row the hosting page found: a program, a copy, the web, Polar. */
export function HostResultRow({ row, query, ...props }: RowProps & { row: HostRow; query: string }) {
    const t = useTranslations("components");
    // The words are the palette's, in the reader's language; the host only
    // says what kind of row it is and, for a program or a copy, its text.
    const quoted = query.slice(0, 120);
    const label =
        row.kind === "web"
            ? t("search.host.webTitle", { query: quoted })
            : row.kind === "polar"
              ? t("search.host.polarTitle", { query: quoted })
              : row.kind === "system" && row.command
                ? t(`search.host.commands.${row.command}`)
                : row.title;
    const context =
        row.kind === "web"
            ? t("search.host.webHint")
            : row.kind === "polar"
              ? t("search.host.polarHint")
              : row.kind === "app"
                ? t("search.host.app")
                : row.kind === "clip"
                  ? t("search.host.clipHint")
                  : row.kind === "system"
                    ? t(row.command && CONFIRMED.has(row.command) ? "search.host.systemConfirmHint" : "search.host.systemHint")
                    : row.subtitle;
    const fallback =
        row.kind === "answer" ? Calculator : row.kind === "system" ? Power : row.kind === "web" ? Globe : row.kind === "clip" ? Clipboard : AppWindow;
    const Icon = fallback;
    const icon =
        row.kind === "polar" ? (
            <AppLogo appId="polar" size={18} fallback={<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />} />
        ) : row.icon ? (
            <img src={row.icon} alt="" width={18} height={18} className="size-[18px] shrink-0 object-contain" />
        ) : (
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        );
    return (
        <Row {...props} label={label}>
            <SearchItem icon={icon} label={label} context={context} />
        </Row>
    );
}
