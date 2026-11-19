"use client";

/**
 * The provider keys an owner brought, in the order they want them tried.
 *
 * One screen serving two owners: the account under /polar/settings/providers and the
 * deployment under /integrations/models. They ask for the same things and behave
 * the same way, so they are the same component - the caller supplies the writes,
 * the wording around the table, and whatever belongs under it.
 *
 * A table rather than a card per provider, because the list is a list: an owner
 * can hold several keys for one provider, and the row above another one means
 * something. The order IS the setting, so it is expressed by dragging rather
 * than by a column of numbers somebody has to keep consistent - and by arrow
 * buttons beside it, since an order only a mouse can express is one a screen
 * reader cannot express at all.
 *
 * A stored key is never shown again. There is nothing to reveal: the field is
 * write-only, and the only thing that proves a key still works is a run.
 */

import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { IntegrationLogo } from "@/components/logos";
import type { AgentSignin } from "@/lib/agents/agent-signins";
import { SigninDialog, type SigninDialogActions, type SigninDialogMode } from "./signin-dialog";
import { useConfirm } from "@/components/confirm-dialog";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SigninStatus } from "@/lib/agents/signin-status";
import { RelativeTime } from "@/components/relative-time";
import type { ModelKeyView } from "@/lib/agents/model-keys";
import type { ProviderRow } from "@/lib/agents/model-key-providers";
import type { KeyActionResult } from "@/lib/agents/model-key-actions";
import { anthropicWorkspaceIdSchema, modelKeyNameSchema } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { ProviderSelect, type ProviderReader } from "@/components/model-keys/provider-select";
import type { KeyHealthView, KeyLimits } from "@/lib/agents/key-limits";
import { isCoolingState, revivedStatus } from "@/lib/agents/key-status";
import { KeyLimitsDialog, KeyStanding } from "@/components/model-keys/key-standing";
import { AddConnectionDialog } from "@/components/model-keys/add-connection";
import { useHubFlow, type ConnectionOption } from "@/components/model-keys/connection-hub";
import {
    arrangeConnections,
    isNarrowed,
    NO_FILTERS,
    type ConnectionEntry,
    type ConnectionFilters,
    type ConnectionSort
} from "@/components/model-keys/connection-rows";
import {
    ChevronDown,
    ChevronUp,
    Gauge,
    GripVertical,
    Info,
    LogIn,
    LogOut,
    MoreHorizontal,
    Pencil,
    Plus,
    RotateCcw,
    Trash2,
    Wand2
} from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    isDirty,
    nextSort,
    SearchableSelect,
    SearchField,
    Select,
    Skeleton,
    SortHeader,
    Switch,
    DateInput,
    type TableSortDirection
} from "@polaris/ui";

/** A provider the deployment holds a key for, and whether this owner's own
 *  key is the one a run spends instead. */
export interface DeploymentKey {
    slug: string;
    name: string;
    yours: boolean;
}

/** The four writes, as the screen that owns them exposes them. Each one is a
 *  server action that has already established who may call it. */
export interface ModelKeyActions {
    add: (input: unknown) => Promise<KeyActionResult>;
    update: (input: unknown) => Promise<KeyActionResult>;
    remove: (input: unknown) => Promise<KeyActionResult>;
    reorder: (input: unknown) => Promise<KeyActionResult>;
    /** Switching one on or off. Absent where the screen offers no switch. */
    toggle?: (input: unknown) => Promise<KeyActionResult>;
    /** Setting a key's own allowance. Absent where the table offers none. */
    limit?: (input: unknown) => Promise<KeyActionResult>;
    /** Putting a cooled key back in rotation now. */
    revive?: (input: unknown) => Promise<KeyActionResult>;
}

/** The words that differ between the two owners. Everything else the table says
 *  is true of both. */
/**
 * A login Polaris can run instead of asking somebody to go and find a terminal.
 *
 * Offered inside the Add dialog, on the providers it knows a login command for.
 * Everything else in that dialog stays exactly as it is: the credential this
 * produces is stored, named, ordered and removed like any other.
 */
export interface AssistedSignin {
    /** The credentials there is a login for, by the slug the table stores. */
    signins: AgentSignin[];
    /** The agents this person connected on their sessions' machine, by
     *  variable - the ones that get a row. Null for an account from before the
     *  list was kept, whose rows come from the first status read. */
    connected?: readonly string[] | null;
    actions: Omit<SigninDialogActions, "save"> & {
        /** Starts the vendor's own sign-out, for a sign-in whose docs name one. */
        signout?: (env: unknown) => Promise<{ id?: string; error?: string }>;
        /** Whether each home login is signed in, asked after the page is drawn. */
        status?: (envs: unknown) => Promise<{ statuses: Record<string, SigninStatus> }>;
    };
}

export interface ModelKeysCopy {
    /** Heading over the table. */
    title: string;
    /**
     * What the button that opens the dialog says, and what the dialog's own
     * button says once it is open.
     *
     * A word rather than a default, because the same table lists two different
     * things: a provider key is a key somebody adds, and an agent account is a
     * subscription somebody signs in - and "Add key" over a list of
     * subscriptions is the screen telling them they are about to buy tokens.
     */
    action?: string;
    /** The line under it, saying what the order means. */
    hint: string;
    /** What the table says when there is nothing in it. */
    empty: string;
    /** The line under the dialog's title when a key is being added. */
    adding: string;
}

/** What the gateway needs beyond a key. Numbers stay as typed until the form is
 *  submitted: a partially typed "20" must not become 20 tokens. */
interface GatewayForm {
    baseUrl: string;
    model: string;
    context: string;
    maxOutput: string;
}

const EMPTY_GATEWAY: GatewayForm = { baseUrl: "", model: "", context: "", maxOutput: "" };

/** The names already spoken for, lowercased, so the dialog can refuse a repeat
 *  while it is being typed. Case-insensitive because two keys called "Prod" and
 *  "prod" are the same name to the person reading the table. */
function namesTaken(rows: ModelKeyView[], exceptId: string | null): Set<string> {
    return new Set(rows.filter((row) => row.id !== exceptId).map((row) => row.name.toLowerCase()));
}

/**
 * Where a key stands against its own end date, or null when the date is far
 * enough off to be nothing but a date. A badge on every dated key would say
 * "Expires" next to the word "expires", and the ones that matter would read the
 * same as the ones that do not.
 */
function expiryStanding(
    iso: string | null,
    t: NamespaceTranslator<"components">
): { label: string; tone: "warning" | "danger" } | null {
    if (!iso) return null;
    const remaining = new Date(iso).getTime() - Date.now();
    if (remaining <= 0) return { label: t("modelKeys.expired"), tone: "danger" };
    const days = Math.ceil(remaining / 86_400_000);
    return days <= 7 ? { label: t("modelKeys.daysLeft", { days }), tone: "warning" } : null;
}

/**
 * When each optional column gets its own cell, and when it rides under the name
 * instead. Tailwind breakpoints follow the window, not the table, so the widths
 * here are the content area's: the 14rem rail arrives at md, which is why nothing
 * arrives there. A table drawn in a narrow column of another page (Connected
 * accounts) keeps every optional column folded, whatever the window.
 */
type Columns = Record<"status" | "expires" | "key" | "lastUsed", { cell: string; fold: string }>;

const WIDE_COLUMNS: Columns = {
    status: { cell: "hidden lg:table-cell", fold: "lg:hidden" },
    expires: { cell: "hidden xl:table-cell", fold: "xl:hidden" },
    key: { cell: "hidden 2xl:table-cell", fold: "2xl:hidden" },
    lastUsed: { cell: "hidden 2xl:table-cell", fold: "" }
};

const NARROW_COLUMNS: Columns = {
    status: { cell: "hidden", fold: "" },
    expires: { cell: "hidden", fold: "" },
    key: { cell: "hidden", fold: "" },
    lastUsed: { cell: "hidden", fold: "" }
};

/** A picked day ends at the end of it, local time - the day itself still works. */
function endOfDay(date: string): Date | null {
    const [year, month, day] = date.split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, 23, 59, 59, 999);
}

/** An ISO instant as the date field wants it: the local calendar day it falls on,
 *  not the UTC one, so a key expiring tonight does not read as tomorrow. */
function asDateValue(iso: string | null): string {
    if (!iso) return "";
    const date = new Date(iso);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

/** Today, local time, as the earliest day a key may be set to stop on. */
function earliestExpiry(): string {
    return asDateValue(new Date().toISOString());
}

export function ModelKeysView({
    providers,
    searchProviders,
    keys,
    actions,
    copy,
    assist,
    footer,
    health,
    connectOptions,
    deployment,
    narrow = false
}: {
    /** The providers the table names: the ones its keys belong to, or - with no
     *  `searchProviders` - every one the Add dialog offers. */
    providers: ProviderRow[];
    /** Pages the Add dialog's provider picker from the server, for a catalogue
     *  too long to hand the browser. */
    searchProviders?: ProviderReader;
    keys: ModelKeyView[];
    /** Each key's standing with Polar's router, by id. Absent where the table
     *  lists something the router does not spend (agent sign-ins). */
    health?: Record<string, KeyHealthView>;
    actions: ModelKeyActions;
    copy: ModelKeysCopy;
    /**
     * The credentials Polaris can run a login for, and how.
     *
     * Reaches the Add dialog rather than sitting beside the table, because that
     * is where somebody has already said which account they are adding: a button
     * outside it asks them to pick the agent twice, once on a card and once in
     * the form, for the same credential.
     */
    assist?: AssistedSignin;
    /** What sits under the table: what a run falls back to on an account's own
     *  screen, and who may spend these on the deployment's. */
    footer?: ReactNode;
    /** Drawn in a narrow column of another page: optional columns stay folded. */
    narrow?: boolean;
    /** The agent accounts and agent sign-ins this table can add, as Add
     *  connection lists them, when it is mounted inside a connection hub. */
    connectOptions?: readonly ConnectionOption[];
    /**
     * The providers the deployment holds a key for, drawn read-only under the
     * account's own rows with whose key a run spends, and the line said under
     * the table where there are none.
     */
    deployment?: { rows: readonly DeploymentKey[]; note?: string };
}) {
    const router = useRouter();
    const columns = narrow ? NARROW_COLUMNS : WIDE_COLUMNS;
    const t = useTranslations("components");
    const [confirm, confirmElement] = useConfirm();
    const [rows, setRows] = useState(keys);
    const [editing, setEditing] = useState<ModelKeyView | null>(null);
    const [adding, setAdding] = useState(false);
    // The provider Add connection opened this dialog on, when it did.
    const [addingRow, setAddingRow] = useState<ProviderRow | null>(null);
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // The table is held in state so a drag can move a row before the server has
    // agreed, which means it has to be put back in step when the server sends a
    // new list - after an add, an edit or a delete. Without this the row somebody
    // just created never appears, because state ignores the new props.
    const [served, setServed] = useState(keys);
    if (served !== keys) {
        setServed(keys);
        setRows(keys);
    }
    // The standings, held the same way so a revive shows at once.
    const [statuses, setStatuses] = useState(health);
    const [servedHealth, setServedHealth] = useState(health);
    if (servedHealth !== health) {
        setServedHealth(health);
        setStatuses(health);
    }
    const [limiting, setLimiting] = useState<ModelKeyView | null>(null);
    // A sign-in whose stored row was just removed, offered a sign-out of the
    // home too: removing the row stops Polaris handing it out, but the tool's
    // own login in the sessions' home is still there.
    const [signoutOffer, setSignoutOffer] = useState<AgentSignin | null>(null);
    // The sign-in dialog opened from this table rather than from Add: a login
    // kept in the home, or a sign-out.
    const [running, setRunning] = useState<{ signin: AgentSignin; mode: SigninDialogMode } | null>(null);
    const homeSignins = useMemo(() => assist?.signins.filter((signin) => signin.home) ?? [], [assist]);

    // Inside a connection hub, Add connection is the one way in: it opens this
    // table's key dialog on the provider picked, and the sign-in dialog for an
    // agent that keeps its login on the machine.
    const openKey = (slug?: string, row?: unknown) => {
        const known = (row as ProviderRow | undefined) ?? providers.find((one) => one.slug === slug) ?? null;
        setAddingRow(known);
        setAdding(true);
    };
    const options = useMemo(() => connectOptions ?? [], [connectOptions]);
    const inHub = useHubFlow("key", openKey, []);
    useHubFlow("account", openKey, options.filter((option) => option.method === "account"));
    useHubFlow(
        "home",
        (slug) => {
            const signin = assist?.signins.find((one) => one.slug === slug && one.home);
            if (signin) setRunning({ signin, mode: "login" });
        },
        options.filter((option) => option.method === "home")
    );
    const canSignOut = (signin: AgentSignin) => Boolean(signin.signout && assist?.actions.signout);

    // Each home login's status, null while it is being asked. Asked after the
    // first paint and again whenever a sign-in or sign-out dialog closes. Never
    // cached in the browser: it is a statement about a login.
    const [homeStatus, setHomeStatus] = useState<Record<string, SigninStatus> | null>(null);
    const [statusTick, setStatusTick] = useState(0);
    const askStatus = assist?.actions.status;
    const homeEnvs = homeSignins.map((signin) => signin.env).join(",");
    useEffect(() => {
        if (!askStatus || !homeEnvs) return;
        let live = true;
        setHomeStatus(null);
        askStatus(homeEnvs.split(","))
            .then((result) => {
                if (live) setHomeStatus(result.statuses);
            })
            .catch(() => {
                if (live) setHomeStatus({});
            });
        return () => {
            live = false;
        };
    }, [askStatus, homeEnvs, statusTick]);

    // The offer a sign-out replaced, put back if the sign-out does not finish.
    const offerBack = useRef<AgentSignin | null>(null);
    // Asked first, in the app's own dialog: a sign-out ends the tool's login in
    // every session that uses the home. The offer goes at once and comes back
    // if the sign-out does not finish.
    const signOut = async (signin: AgentSignin) => {
        const tool = signin.serves[0]?.label ?? signin.label;
        const ok = await confirm({
            title: t("modelKeys.signoutTitle", { tool }),
            description: t("modelKeys.signoutBody", { tool }),
            confirmLabel: t("modelKeys.signout"),
            danger: true
        });
        if (!ok) return;
        const offered = signoutOffer;
        setSignoutOffer(null);
        setRunning({ signin, mode: "logout" });
        offerBack.current = offered;
    };

    const byslug = useMemo(
        () => new Map(providers.map((provider) => [provider.slug, provider])),
        [providers]
    );

    // The one table: stored keys and agent accounts in their order, then the
    // agents signed in on the sessions' machine, then - read-only and last,
    // since they are the fallback - the keys the deployment holds.
    const accountSlugs = useMemo(
        () =>
            new Set([
                ...(assist?.signins ?? []).map((signin) => signin.slug),
                ...options.filter((option) => option.method === "account").map((option) => option.slug)
            ]),
        [assist, options]
    );
    const homeByEnv = useMemo(() => new Map(homeSignins.map((signin) => [signin.env, signin])), [homeSignins]);
    const deploymentBySlug = useMemo(
        () => new Map((deployment?.rows ?? []).map((held) => [held.slug, held])),
        [deployment]
    );
    const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
    const entries = useMemo<ConnectionEntry[]>(() => {
        const stored = rows.map<ConnectionEntry>((row, position) => {
            const health = statuses?.[row.id];
            const expired = expiryStanding(row.expiresAt, t)?.tone === "danger";
            return {
                id: row.id,
                kind: accountSlugs.has(row.provider) ? "account" : "key",
                provider: row.provider,
                providerName: byslug.get(row.provider)?.name ?? row.provider,
                name: row.name,
                status: !row.enabled
                    ? "off"
                    : expired || (health && health.state !== "ready")
                      ? "problem"
                      : "working",
                lastUsedAt: row.lastUsedAt,
                position
            };
        });
        // Only the agents this person connected - not every agent there is a
        // login for. Add connection is where the rest are offered.
        const connectedHomes = new Set(assist?.connected ?? []);
        const shown = homeSignins.filter(
            (signin) => connectedHomes.has(signin.env) || homeStatus?.[signin.env]?.state === "in"
        );
        const agents = shown.map<ConnectionEntry>((signin, index) => {
            const known = homeStatus?.[signin.env];
            return {
                id: `${HOME_PREFIX}${signin.env}`,
                kind: "agent",
                provider: signin.slug,
                providerName: signin.serves[0]?.label ?? signin.label,
                name: signin.serves[0]?.label ?? signin.label,
                status: !askStatus
                    ? "working"
                    : homeStatus === null
                      ? "checking"
                      : known?.state === "out"
                        ? "off"
                        : "working",
                lastUsedAt: null,
                position: rows.length + index
            };
        });
        // A shared key is listed only where it is the one used: where the person
        // has a key of their own, that key's row already says so.
        const held = (deployment?.rows ?? []).filter((one) => !one.yours).map<ConnectionEntry>((one, index) => ({
            id: `deployment:${one.slug}`,
            kind: "deployment",
            provider: one.slug,
            providerName: one.name,
            name: t("modelKeys.table.deploymentName"),
            status: one.yours ? "off" : "working",
            lastUsedAt: null,
            position: rows.length + shown.length + index
        }));
        return [...stored, ...agents, ...held];
    }, [rows, statuses, accountSlugs, byslug, homeSignins, homeStatus, askStatus, deployment, assist, t]);

    const [search, setSearch] = useState("");
    const typed = useDeferredValue(search);
    const [filters, setFilters] = useState<ConnectionFilters>(NO_FILTERS);
    const [sort, setSort] = useState<{ order: ConnectionSort; direction: TableSortDirection }>({
        order: "priority",
        direction: "asc"
    });
    const sortBy = (order: ConnectionSort) => setSort((current) => nextSort(current, order));
    const applied = useMemo(() => ({ ...filters, query: typed }), [filters, typed]);
    const arranged = useMemo(() => arrangeConnections(entries, applied, sort), [entries, applied, sort]);
    // A row can only be moved where the table shows the order it moves in.
    const sortedOtherwise = sort.order !== "priority" || sort.direction !== "asc";
    const reorderable = !sortedOtherwise && !isNarrowed({ ...filters, query: search });
    const reorderReason = sortedOtherwise
        ? t("modelKeys.table.sortedNote")
        : t("modelKeys.table.filteredNote");
    const showStatus = Boolean(statuses) || homeSignins.length > 0 || (deployment?.rows.length ?? 0) > 0;

    const providerOptions = useMemo(() => {
        const names = new Map(entries.map((entry) => [entry.provider, entry.providerName]));
        return [
            { value: "all", label: t("modelKeys.table.allProviders") },
            ...[...names.entries()]
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([value, label]) => ({ value, label }))
        ];
    }, [entries, t]);
    const kindOptions = useMemo(() => {
        const present = new Set(entries.map((entry) => entry.kind));
        return (["all", "key", "account", "agent", "deployment"] as const)
            .filter((kind) => kind === "all" || present.has(kind))
            .map((value) => ({ value, label: t(`modelKeys.table.kinds.${value}`) }));
    }, [entries, t]);

    const persistOrder = (next: ModelKeyView[]) => {
        const previous = rows;
        setRows(next);
        setError(null);
        void (async () => {
            const result = await runAction(
                () => actions.reorder({ ids: next.map((row) => row.id) }),
                setError
            );
            // Rolled back rather than left showing an order the server does not
            // hold: a list that lies about which key is first is worse than one
            // that snaps back.
            if (!result || result.error) {
                setRows(previous);
                if (result?.error) setError(result.error);
            }
        })();
    };

    const move = (from: number, to: number) => {
        if (to < 0 || to >= rows.length || from === to) return;
        const next = [...rows];
        const [row] = next.splice(from, 1);
        if (!row) return;
        next.splice(to, 0, row);
        persistOrder(next);
    };

    // Flipped at once and put back if the server refuses: the switch is the
    // state, and one that waits for a round trip reads as broken.
    const toggle = actions.toggle
        ? async (key: ModelKeyView, enabled: boolean) => {
              const previous = rows;
              setRows(rows.map((row) => (row.id === key.id ? { ...row, enabled } : row)));
              setError(null);
              const result = await runAction(
                  () => actions.toggle!({ id: key.id, enabled }),
                  setError
              );
              if (!result || result.error) {
                  setRows(previous);
                  if (result?.error) setError(result.error);
                  return;
              }
              router.refresh();
          }
        : null;

    // Shown back in rotation at once, and put back if the server refuses.
    const revive = actions.revive
        ? async (key: ModelKeyView) => {
              const current = statuses?.[key.id];
              if (!current) return;
              const previous = statuses;
              setStatuses({ ...statuses, [key.id]: revivedStatus(current) });
              setError(null);
              const result = await runAction(() => actions.revive!({ id: key.id }), setError);
              if (!result || result.error) {
                  setStatuses(previous);
                  if (result?.error) setError(result.error);
                  return;
              }
              router.refresh();
          }
        : null;

    // Saved into the row at once; the dialog stays open on a refusal and the
    // row goes back to what the server holds.
    const saveLimits = async (key: ModelKeyView, limits: KeyLimits): Promise<string | null> => {
        if (!actions.limit) return null;
        const previous = rows;
        setRows(rows.map((row) => (row.id === key.id ? { ...row, limits } : row)));
        let failure: string | null = null;
        const result = await runAction(
            () => actions.limit!({ id: key.id, limits }),
            (message) => {
                failure = message;
            }
        );
        if (!result || result.error) {
            setRows(previous);
            return result?.error ?? failure ?? t("modelKeys.limits.failed");
        }
        setLimiting(null);
        router.refresh();
        return null;
    };

    const remove = async (key: ModelKeyView) => {
        const provider = byslug.get(key.provider);
        const ok = await confirm({
            title: t("modelKeys.deleteTitle", { name: key.name }),
            description: t("modelKeys.deleteBody", { provider: provider?.name ?? key.provider }),
            confirmLabel: t("modelKeys.delete"),
            danger: true
        });
        if (!ok) return;
        const previous = rows;
        setRows(rows.filter((row) => row.id !== key.id));
        setError(null);
        const result = await runAction(() => actions.remove({ id: key.id }), setError);
        if (!result || result.error) {
            setRows(previous);
            if (result?.error) setError(result.error);
            return;
        }
        const signin = assist?.signins.find((one) => one.slug === key.provider);
        setSignoutOffer(signin && canSignOut(signin) ? signin : null);
        router.refresh();
    };

    return (
        <div className="flex flex-col gap-4">
            {error ? <p className="text-danger text-sm">{error}</p> : null}
            {/* Bordered rather than plain text: it is the outcome of the save that
                just happened, and a muted line under the heading reads as part of
                the page's own copy. */}
            {notice ? (
                <p className="rounded-lg border border-warning-edge bg-warning-soft px-3 py-2 text-sm text-warning-ink">
                    {notice}
                </p>
            ) : null}

            {signoutOffer ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
                    <p className="min-w-0 flex-1 text-sm">
                        {t("modelKeys.signoutOffer", {
                            tool: signoutOffer.serves[0]?.label ?? signoutOffer.label
                        })}
                    </p>
                    <Button size="sm" variant="ghost" onClick={() => setSignoutOffer(null)}>
                        {t("modelKeys.signoutKeep")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void signOut(signoutOffer)}>
                        <LogOut className="size-4 shrink-0" />
                        {t("modelKeys.signout")}
                    </Button>
                </div>
            ) : null}

            {/* No card around it, as on Account > API keys: a table inside a
                padded card inside a reading column is a table that scrolls
                sideways while half the screen is empty. */}
            <section className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">{copy.title}</h2>
                        <p className="text-muted-foreground text-xs">{copy.hint}</p>
                    </div>
                    <Button size="sm" className="shrink-0" onClick={() => (inHub ? setConnecting(true) : setAdding(true))}>
                        <Plus className="size-4 shrink-0" />
                        {inHub ? t("modelKeys.connect.addConnection") : (copy.action ?? t("modelKeys.addKey"))}
                    </Button>
                </div>

                {/* The toolbar every Polaris list has: search, then filters. A
                    filter only appears where the table holds more than one of
                    what it filters by. */}
                {entries.length > 1 ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <SearchField
                            wrapperClassName="flex-1 basis-48"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t("modelKeys.table.search")}
                            aria-label={t("modelKeys.table.search")}
                            maxLength={200}
                        />
                        {providerOptions.length > 2 ? (
                            <Select
                                value={filters.provider}
                                onValueChange={(value) => setFilters((current) => ({ ...current, provider: value }))}
                                aria-label={t("modelKeys.table.providerLabel")}
                                className="w-44"
                                options={providerOptions}
                            />
                        ) : null}
                        {kindOptions.length > 2 ? (
                            <Select
                                value={filters.kind}
                                onValueChange={(value) =>
                                    setFilters((current) => ({ ...current, kind: value as ConnectionFilters["kind"] }))
                                }
                                aria-label={t("modelKeys.table.kindLabel")}
                                className="w-44"
                                options={kindOptions}
                            />
                        ) : null}
                        <Select
                            value={filters.status}
                            onValueChange={(value) =>
                                setFilters((current) => ({ ...current, status: value as ConnectionFilters["status"] }))
                            }
                            aria-label={t("modelKeys.table.statusLabel")}
                            className="w-44"
                            options={STATUS_FILTERS.map((value) => ({
                                value,
                                label: t(`modelKeys.table.statuses.${value}`)
                            }))}
                        />
                    </div>
                ) : null}

                {!reorderable && rows.length > 1 ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="min-w-0 flex-1">{reorderReason}</span>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="shrink-0"
                            onClick={() => {
                                setSort({ order: "priority", direction: "asc" });
                                setSearch("");
                                setFilters(NO_FILTERS);
                            }}
                        >
                            {t("modelKeys.table.sortByOrder")}
                        </Button>
                    </div>
                ) : null}

                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                        {/* Each column waits for the width that holds it, and nothing
                            arrives at md: that is where the navigation rail appears, so
                            the content area is narrower there than a breakpoint
                            earlier. */}
                        <thead className="bg-surface/60 text-start text-xs text-muted-foreground">
                            <tr>
                                <SortHeader
                                    className="w-10"
                                    label={<span className="sr-only sm:not-sr-only">#</span>}
                                    order="priority"
                                    sort={sort}
                                    onSort={sortBy}
                                />
                                <SortHeader label={t("modelKeys.provider")} order="provider" sort={sort} onSort={sortBy} />
                                {/* w-full max-w-0: the name is the column that gives, so
                                    a long one truncates instead of spilling the table
                                    sideways. */}
                                <SortHeader
                                    className="w-full min-w-24 max-w-0"
                                    label={t("modelKeys.name")}
                                    order="name"
                                    sort={sort}
                                    onSort={sortBy}
                                />
                                <th className={`${columns.key.cell} whitespace-nowrap px-3 py-2 font-medium`}>
                                    {t("modelKeys.key")}
                                </th>
                                {showStatus ? (
                                    <SortHeader
                                        className={columns.status.cell}
                                        label={t("modelKeys.status.title")}
                                        order="status"
                                        sort={sort}
                                        onSort={sortBy}
                                    />
                                ) : null}
                                <th className={`${columns.expires.cell} whitespace-nowrap px-3 py-2 font-medium`}>
                                    {t("modelKeys.expires")}
                                </th>
                                <SortHeader
                                    className={columns.lastUsed.cell}
                                    label={t("modelKeys.lastUsed")}
                                    order="lastUsed"
                                    sort={sort}
                                    onSort={sortBy}
                                />
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {arranged.length === 0 ? (
                                <tr>
                                    <td colSpan={showStatus ? 8 : 7} className="text-muted-foreground px-3 py-8 text-center">
                                        {entries.length === 0 ? copy.empty : t("modelKeys.table.noMatch")}
                                    </td>
                                </tr>
                            ) : (
                                arranged.map((entry) => {
                                    if (entry.kind === "agent") {
                                        const signin = homeByEnv.get(entry.id.slice(HOME_PREFIX.length))!;
                                        return (
                                            <AgentRow
                                                key={entry.id}
                                                signin={signin}
                                                columns={columns}
                                                showStatus={showStatus}
                                                status={askStatus ? (homeStatus ? (homeStatus[signin.env] ?? null) : undefined) : null}
                                                canSignOut={canSignOut(signin)}
                                                onSignIn={() => setRunning({ signin, mode: "login" })}
                                                onSignOut={() => void signOut(signin)}
                                            />
                                        );
                                    }
                                    if (entry.kind === "deployment") {
                                        const held = deploymentBySlug.get(entry.provider)!;
                                        return (
                                            <DeploymentRow
                                                key={entry.id}
                                                slug={held.slug}
                                                name={held.name}
                                                yours={held.yours}
                                                columns={columns}
                                                showStatus={showStatus}
                                            />
                                        );
                                    }
                                    const row = rowById.get(entry.id)!;
                                    return (
                                        <KeyRow
                                            key={row.id}
                                            row={row}
                                            columns={columns}
                                            provider={byslug.get(row.provider) ?? null}
                                            index={entry.position}
                                            total={rows.length}
                                            reorderable={reorderable}
                                            reorderReason={reorderReason}
                                            onMove={move}
                                            onEdit={() => setEditing(row)}
                                            onRemove={() => void remove(row)}
                                            onToggle={toggle ? (enabled) => void toggle(row, enabled) : null}
                                            status={showStatus ? (statuses?.[row.id] ?? null) : undefined}
                                            onLimits={
                                                // Only a key the router spends has limits: an agent's
                                                // account in the same list is not one.
                                                actions.limit && statuses && row.id in statuses
                                                    ? () => setLimiting(row)
                                                    : null
                                            }
                                            onRevive={revive ? () => void revive(row) : null}
                                        />
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
                {deployment?.note ? <p className="text-muted-foreground text-xs">{deployment.note}</p> : null}
            </section>
            {running && assist ? (
                <SigninDialog
                    key={`${running.signin.env}-${running.mode}`}
                    signin={running.signin}
                    mode={running.mode}
                    actions={{
                        ...assist.actions,
                        begin:
                            running.mode === "logout" && assist.actions.signout
                                ? assist.actions.signout
                                : assist.actions.begin,
                        // Nothing from these is stored.
                        save: async () => ({})
                    }}
                    onClose={() => {
                        // A sign-out that did not finish: the offer is back.
                        if (running.mode === "logout" && offerBack.current) setSignoutOffer(offerBack.current);
                        offerBack.current = null;
                        setRunning(null);
                        setStatusTick((tick) => tick + 1);
                    }}
                    onDone={() => {
                        offerBack.current = null;
                        setRunning(null);
                        setStatusTick((tick) => tick + 1);
                    }}
                />
            ) : null}

            {footer}

            {/* Mounted only while open, so every dialog starts empty. A form that
                survives being closed is one that offers the last key's name back,
                and holds a pasted secret in memory for the rest of the session. */}
            {connecting ? (
                <AddConnectionDialog
                    searchProviders={searchProviders}
                    providers={providers}
                    onClose={() => setConnecting(false)}
                />
            ) : null}
            {adding ? (
                <KeyDialog
                    initial={addingRow}
                    providers={providers}
                    searchProviders={searchProviders}
                    actions={actions}
                    adding={copy.adding}
                    action={copy.action}
                    assist={assist}
                    existing={null}
                    takenNames={namesTaken(rows, null)}
                    onClose={() => {
                        setAdding(false);
                        setAddingRow(null);
                    }}
                    onSaved={(warning) => {
                        setAdding(false);
                        setAddingRow(null);
                        setNotice(warning ?? null);
                        router.refresh();
                    }}
                />
            ) : null}
            {editing ? (
                <KeyDialog
                    key={editing.id}
                    providers={providers}
                    actions={actions}
                    adding={copy.adding}
                    action={copy.action}
                    assist={assist}
                    existing={editing}
                    takenNames={namesTaken(rows, editing.id)}
                    onClose={() => setEditing(null)}
                    onSaved={(warning) => {
                        setEditing(null);
                        setNotice(warning ?? null);
                        router.refresh();
                    }}
                />
            ) : null}
            {limiting ? (
                <KeyLimitsDialog
                    key={limiting.id}
                    keyRow={limiting}
                    status={statuses?.[limiting.id] ?? null}
                    onClose={() => setLimiting(null)}
                    onSave={(limits) => saveLimits(limiting, limits)}
                />
            ) : null}
            {confirmElement}
        </div>
    );
}

/** The id prefix of an agent signed in on the sessions' machine. */
const HOME_PREFIX = "home:";

/** The status filter's values, in the order the menu offers them. */
const STATUS_FILTERS = ["all", "working", "problem", "checking", "off"] as const;

/**
 * An agent whose login lives on the sessions' machine: nothing is stored, so
 * the row cannot be moved, and its actions are the vendor's sign-in and, where
 * the vendor documents one, sign-out.
 */
function AgentRow({
    signin,
    columns,
    showStatus,
    status,
    canSignOut,
    onSignIn,
    onSignOut
}: {
    signin: AgentSignin;
    columns: Columns;
    showStatus: boolean;
    /** Undefined while asked, null where nothing is known. */
    status: SigninStatus | null | undefined;
    canSignOut: boolean;
    onSignIn: () => void;
    onSignOut: () => void;
}) {
    const t = useTranslations("components");
    const tool = signin.serves[0]?.label ?? signin.label;
    // Named for what it is - the agent's own login - so it does not read as a
    // second "Cursor" beside the Cursor key.
    const name = t("modelKeys.connect.ways.login", { name: tool });
    const signedIn = status?.state === "in" && canSignOut;
    const other = signedIn ? "login" : canSignOut ? "logout" : null;
    const signInAction = (
        <>
            <LogIn className="size-4 shrink-0" />
            <span className="truncate">{t("modelKeys.homeSignin")}</span>
        </>
    );
    const signOutAction = (
        <>
            <LogOut className="size-4 shrink-0" />
            <span className="truncate">{t("modelKeys.signout")}</span>
        </>
    );
    return (
        <tr className="border-t border-border">
            {/* No handle: nothing is stored, so there is nothing to move. Says so
                where the handle would be instead of leaving a blank. */}
            <td className="px-2 py-2">
                <span
                    className="grid size-6 place-items-center text-muted-foreground/60"
                    title={t("modelKeys.table.agentOrder", { tool })}
                    aria-label={t("modelKeys.table.agentOrder", { tool })}
                >
                    <Info className="size-3.5 shrink-0" />
                </span>
            </td>
            <td className="px-3 py-2">
                <div className="flex max-w-40 items-center gap-2">
                    <IntegrationLogo slug={signin.serves[0]?.id ?? signin.slug} name={tool} className="size-4 shrink-0" />
                    <span className="min-w-0 truncate whitespace-nowrap" title={tool}>
                        {tool}
                    </span>
                </div>
            </td>
            <td className="w-full max-w-0 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-medium" title={name}>
                        {name}
                    </span>
                    {showStatus ? null : <HomeStatusBadge status={status} t={t} />}
                </span>
                <span
                    className={`text-muted-foreground block truncate text-xs ${columns.key.fold}`}
                    title={t("modelKeys.table.agentKey")}
                >
                    {t("modelKeys.table.agentKey")}
                </span>
            </td>
            <td className={`text-muted-foreground ${columns.key.cell} whitespace-nowrap px-3 py-2 text-xs`}>
                {t("modelKeys.table.agentKey")}
            </td>
            {showStatus ? (
                <td className={`${columns.status.cell} px-3 py-2`}>
                    <HomeStatusBadge status={status} t={t} />
                </td>
            ) : null}
            <td className={`${columns.expires.cell} text-muted-foreground whitespace-nowrap px-3 py-2`}>-</td>
            <td className={`${columns.lastUsed.cell} text-muted-foreground whitespace-nowrap px-3 py-2`}>-</td>
            <td className="px-3 py-2">
                <div className="flex items-center justify-end gap-1">
                    <Button
                        size="sm"
                        variant="outline"
                        className="max-w-40 shrink-0"
                        onClick={signedIn ? onSignOut : onSignIn}
                    >
                        {signedIn ? signOutAction : signInAction}
                    </Button>
                    {other ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="shrink-0"
                                    aria-label={t("modelKeys.moreNamed", { name: tool })}
                                    title={t("modelKeys.more")}
                                >
                                    <MoreHorizontal className="size-4 shrink-0" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={other === "logout" ? onSignOut : onSignIn}>
                                    {other === "logout" ? signOutAction : signInAction}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}
                </div>
            </td>
        </tr>
    );
}

/** A key the deployment holds: read-only, and whose key a run actually spends. */
function DeploymentRow({
    slug,
    name,
    yours,
    columns,
    showStatus
}: {
    slug: string;
    name: string;
    yours: boolean;
    columns: Columns;
    showStatus: boolean;
}) {
    const t = useTranslations("components");
    const label = yours ? t("modelKeys.table.usingYours") : t("modelKeys.table.usingDeployment");
    const badge = (
        <Badge variant={yours ? "neutral" : "primary"} className="min-w-0 shrink truncate" title={label}>
            {label}
        </Badge>
    );
    return (
        <tr className="border-t border-border bg-surface/30" title={t("modelKeys.table.deploymentHint")}>
            <td className="px-2 py-2">
                <span className="sr-only">{t("modelKeys.table.readOnly")}</span>
            </td>
            <td className="px-3 py-2">
                <div className="flex max-w-40 items-center gap-2">
                    <IntegrationLogo slug={slug} name={name} className="size-4 shrink-0" />
                    <span className="min-w-0 truncate whitespace-nowrap" title={name}>
                        {name}
                    </span>
                </div>
            </td>
            <td className="w-full max-w-0 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="text-muted-foreground min-w-0 truncate" title={t("modelKeys.table.deploymentName")}>
                        {t("modelKeys.table.deploymentName")}
                    </span>
                    {showStatus ? <span className={`flex min-w-0 ${columns.status.fold}`}>{badge}</span> : badge}
                </span>
            </td>
            <td className={`${columns.key.cell} px-3 py-2`} />
            {showStatus ? <td className={`${columns.status.cell} px-3 py-2`}>{badge}</td> : null}
            <td className={`${columns.expires.cell} px-3 py-2`} />
            <td className={`${columns.lastUsed.cell} px-3 py-2`} />
            <td className="px-3 py-2" />
        </tr>
    );
}
/**
 * A home login's status: a skeleton while it is asked (undefined), unknown when
 * nothing came back for it (null), and "last known" when the answer is the last
 * sign-in or sign-out run here rather than the tool's own.
 */
function HomeStatusBadge({
    status,
    t
}: {
    status: SigninStatus | null | undefined;
    t: NamespaceTranslator<"components">;
}) {
    if (status === undefined) {
        return <Skeleton className="h-[18px] w-20" aria-label={t("modelKeys.statusChecking")} />;
    }
    const state = status?.state ?? "unknown";
    const label =
        state === "in"
            ? t("modelKeys.statusIn")
            : state === "out"
              ? t("modelKeys.statusOut")
              : t("modelKeys.statusUnknown");
    const lastKnown = status?.lastKnown === true;
    return (
        <Badge
            variant={state === "in" ? "success" : "neutral"}
            title={lastKnown ? t("modelKeys.statusLastKnownHint") : undefined}
        >
            {lastKnown ? t("modelKeys.statusLastKnown", { status: label }) : label}
        </Badge>
    );
}

function KeyRow({
    row,
    columns,
    provider,
    index,
    total,
    reorderable,
    reorderReason,
    onMove,
    onEdit,
    onRemove,
    onToggle,
    status,
    onLimits,
    onRevive
}: {
    row: ModelKeyView;
    columns: Columns;
    provider: ProviderRow | null;
    index: number;
    total: number;
    /** Whether the table shows the stored order, which is when a row can move. */
    reorderable: boolean;
    reorderReason: string;
    onMove: (from: number, to: number) => void;
    onEdit: () => void;
    onRemove: () => void;
    onToggle: ((enabled: boolean) => void) | null;
    /** Undefined where the table shows no standing; null for a key it has none for. */
    status?: KeyHealthView | null;
    onLimits?: (() => void) | null;
    onRevive?: (() => void) | null;
}) {
    const t = useTranslations("components");
    const [over, setOver] = useState(false);
    const label = provider?.name ?? row.provider;
    const standing = expiryStanding(row.expiresAt, t);
    const expired = standing?.tone === "danger";

    return (
        <tr
            draggable={reorderable}
            onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))}
            onDragOver={(event) => {
                if (!reorderable) return;
                // Without this the drop never fires: the default handling of a
                // dragover is to refuse the drop.
                event.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                event.preventDefault();
                setOver(false);
                const from = Number(event.dataTransfer.getData("text/plain"));
                if (Number.isInteger(from)) onMove(from, index);
            }}
            className={`border-t border-border ${over ? "bg-muted/40" : ""} ${expired || !row.enabled ? "opacity-60" : ""}`}
        >
            <td className="px-2 py-2" title={reorderable ? undefined : reorderReason}>
                <div className="flex items-center gap-1">
                    <GripVertical
                        className={`text-muted-foreground size-4 shrink-0 ${reorderable ? "cursor-grab" : "opacity-30"}`}
                        aria-hidden
                    />
                    <span className="text-muted-foreground w-4 shrink-0 text-xs tabular-nums">
                        {index + 1}
                    </span>
                </div>
            </td>
            <td className="px-3 py-2">
                {/* Capped, so one long vendor name cannot push the table sideways. */}
                <div className="flex max-w-40 items-center gap-2">
                    <IntegrationLogo slug={row.provider} name={label} className="size-4 shrink-0" />
                    <span className="min-w-0 truncate whitespace-nowrap" title={label}>
                        {label}
                    </span>
                </div>
            </td>
            <td className="w-full max-w-0 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-medium" title={row.name}>
                        {row.name}
                    </span>
                    {/* The badge rides with the name rather than only in its own
                        column: that column is the first thing dropped on a narrow
                        screen, and "this key is dead" is not a detail to hide. */}
                    {standing ? (
                        <Badge variant={standing.tone} className={`shrink-0 ${columns.expires.fold}`}>
                            {standing.label}
                        </Badge>
                    ) : null}
                    {row.enabled ? null : <Badge className="shrink-0">{t("modelKeys.off")}</Badge>}
                    {/* The standing rides with the name below sm, where its own
                        column is dropped; a ready key says nothing there. */}
                    {status && status.state !== "ready" ? (
                        <span className={`shrink-0 ${columns.status.fold}`}>
                            <KeyStanding status={status} compact />
                        </span>
                    ) : null}
                </span>
                {/* Under the name until its own column fits, so two keys of one
                    provider can still be told apart on a phone. */}
                {row.keyHint ? (
                    <span
                        className={`text-muted-foreground block truncate font-mono text-xs ${columns.key.fold}`}
                    >
                        {row.keyHint}
                    </span>
                ) : null}
            </td>
            <td
                className={`text-muted-foreground ${columns.key.cell} whitespace-nowrap px-3 py-2 font-mono text-xs`}
            >
                {row.keyHint || null}
            </td>
            {status !== undefined ? (
                <td className={`${columns.status.cell} px-3 py-2`}>
                    {/* The cap is on a block inside the cell: a max-width on an auto
                        table cell is ignored. */}
                    {status ? (
                        <div className="max-w-56">
                            <KeyStanding status={status} />
                        </div>
                    ) : null}
                </td>
            ) : null}
            <td className={`${columns.expires.cell} whitespace-nowrap px-3 py-2`}>
                {row.expiresAt ? (
                    <span className="flex items-center gap-2">
                        <span className="text-muted-foreground">
                            <RelativeTime iso={row.expiresAt} tense={expired ? "past" : "future"} />
                        </span>
                        {standing ? <Badge variant={standing.tone}>{standing.label}</Badge> : null}
                    </span>
                ) : (
                    <span className="text-muted-foreground">{t("modelKeys.never")}</span>
                )}
            </td>
            <td className={`text-muted-foreground ${columns.lastUsed.cell} whitespace-nowrap px-3 py-2`}>
                {row.lastUsedAt ? <RelativeTime iso={row.lastUsedAt} /> : t("modelKeys.never")}
            </td>
            <td className="px-3 py-2">
                <div className="flex items-center justify-end gap-1">
                    {onToggle ? (
                        <span
                            className="me-1 inline-flex"
                            title={row.enabled ? t("modelKeys.turnOff") : t("modelKeys.turnOn")}
                        >
                            <Switch
                                checked={row.enabled}
                                onChange={onToggle}
                                aria-label={t("modelKeys.useNamed", { name: row.name })}
                            />
                        </span>
                    ) : null}
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onEdit}
                        aria-label={t("modelKeys.editNamed", { name: row.name })}
                        title={t("modelKeys.edit")}
                    >
                        <Pencil className="size-4 shrink-0" />
                    </Button>
                    {/* The rest in one menu, so every row ends in the same two
                        buttons and a key that can be revived does not push its
                        row out of line with the others. */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t("modelKeys.moreNamed", { name: row.name })}
                                title={t("modelKeys.more")}
                            >
                                <MoreHorizontal className="size-4 shrink-0" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-44">
                            {onRevive && status && isCoolingState(status.state) ? (
                                <DropdownMenuItem onSelect={onRevive}>
                                    <RotateCcw />
                                    {t("modelKeys.status.revive")}
                                </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                                disabled={!reorderable || index === 0}
                                onSelect={() => onMove(index, index - 1)}
                            >
                                <ChevronUp />
                                {t("modelKeys.moveUp")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                disabled={!reorderable || index === total - 1}
                                onSelect={() => onMove(index, index + 1)}
                            >
                                <ChevronDown />
                                {t("modelKeys.moveDown")}
                            </DropdownMenuItem>
                            {reorderable ? null : (
                                <p className="max-w-56 px-2 py-1 text-xs text-muted-foreground">{reorderReason}</p>
                            )}
                            {onLimits ? (
                                <DropdownMenuItem onSelect={onLimits}>
                                    <Gauge />
                                    {t("modelKeys.limits.action")}
                                </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="danger" onSelect={onRemove}>
                                <Trash2 />
                                {t("modelKeys.delete")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </td>
        </tr>
    );
}

/**
 * Adding one, or editing one that exists.
 *
 * The same form both ways, because they ask for the same things - the only
 * difference is that an existing key's provider is fixed (a key belongs to the
 * provider that issued it) and its secret may be left alone.
 */
function KeyDialog({
    initial,
    providers,
    searchProviders,
    actions,
    adding,
    action,
    assist,
    existing,
    takenNames,
    onClose,
    onSaved
}: {
    /** The provider a new key starts on, picked before the dialog opened. */
    initial?: ProviderRow | null;
    providers: ProviderRow[];
    searchProviders?: ProviderReader;
    actions: ModelKeyActions;
    /** What adding a key means on this screen, said under the title. */
    adding: string;
    /** The word this screen uses for it, on the button that finishes. */
    action?: string;
    /** Set where Polaris can run this provider's login itself. */
    assist?: AssistedSignin;
    /** The key being edited, or null when this is a new one. */
    existing: ModelKeyView | null;
    /** Every name this owner already uses, lowercased, minus the row being
     *  edited. The server holds the same rule; this is so somebody finds out
     *  while typing rather than after pasting a key and pressing Save. */
    takenNames: Set<string>;
    onClose: () => void;
    onSaved: (warning?: string) => void;
}) {
    const t = useTranslations("components");
    const tcommon = useTranslations("common");
    const [provider, setProvider] = useState(
        existing?.provider ?? initial?.slug ?? (searchProviders ? "" : (providers[0]?.slug ?? ""))
    );
    // The row the async picker answered with, which the table's list may lack.
    const [picked, setPicked] = useState<ProviderRow | null>(existing ? null : (initial ?? null));
    const [name, setName] = useState(existing?.name ?? "");
    const [secret, setSecret] = useState("");
    const [signingIn, setSigningIn] = useState(false);
    // Whose account this is, once the login says. Carried to the write so the
    // stored row can show an address rather than only the name somebody typed.
    const [identity, setIdentity] = useState<Record<string, string>>({});
    const [expiry, setExpiry] = useState(() => asDateValue(existing?.expiresAt ?? null));
    const [gateway, setGateway] = useState<GatewayForm>(() => readGateway(existing));
    const [touched, setTouched] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const storedWorkspace =
        typeof existing?.config.workspaceId === "string" ? existing.config.workspaceId : "";
    const [workspace, setWorkspace] = useState(storedWorkspace);
    // Set once Anthropic answered that this key has to name a workspace.
    const [askedForWorkspace, setAskedForWorkspace] = useState(false);

    const entry =
        (picked?.slug === provider ? picked : null) ??
        providers.find((row) => row.slug === provider) ??
        null;
    const nameCheck = modelKeyNameSchema.safeParse(name);
    const taken = takenNames.has(name.trim().toLowerCase());
    const nameError =
        touched && name.length > 0
            ? taken
                ? t("modelKeys.nameTaken")
                : nameCheck.success
                  ? null
                  : t("modelKeys.nameHint")
            : null;
    // A gateway with no token is a real setup - plenty accept unauthenticated
    // calls from inside the network - so only a provider needs the field filled.
    const secretReady =
        secret.trim().length >= 8 || (entry?.isGateway ?? false) || existing !== null;
    const gatewayReady =
        !entry?.isGateway || (gateway.baseUrl.trim().length > 0 && gateway.model.trim().length > 0);
    // Asked for where it can matter: an Anthropic key whose prefix says it acts
    // as a person (sk-ant-usr-), one already stored (its prefix is not readable
    // back), or one Anthropic just refused for want of a workspace.
    const showWorkspace =
        provider === "anthropic" &&
        (existing !== null ||
            askedForWorkspace ||
            secret.trim().startsWith("sk-ant-usr-") ||
            workspace.trim().length > 0);
    const typedWorkspace = workspace.trim();
    const workspaceError =
        showWorkspace &&
        typedWorkspace.length > 0 &&
        !anthropicWorkspaceIdSchema.safeParse(typedWorkspace).success
            ? t("modelKeys.workspaceShape")
            : null;
    const expiresAt = expiry ? endOfDay(expiry) : null;
    const expiryReady = expiry === "" || (expiresAt !== null && expiresAt.getTime() > Date.now());
    const ready =
        provider !== "" &&
        nameCheck.success &&
        !taken &&
        secretReady &&
        gatewayReady &&
        workspaceError === null &&
        expiryReady;
    // A key that exists, put back as it is, has nothing to save. A typed secret
    // is always a change: the stored one is never read back.
    const unchanged =
        existing !== null &&
        secret.trim() === "" &&
        !isDirty(
            {
                name: existing.name,
                expiry: asDateValue(existing.expiresAt ?? null),
                gateway: entry?.isGateway ? readGateway(existing) : null,
                workspace: storedWorkspace.trim()
            },
            {
                name: name.trim(),
                expiry,
                gateway: entry?.isGateway ? gateway : null,
                workspace: typedWorkspace
            }
        );

    const submit = async () => {
        setBusy(true);
        setError(null);
        const config = entry?.isGateway
            ? {
                  baseUrl: gateway.baseUrl.trim(),
                  model: gateway.model.trim(),
                  context: Number(gateway.context) || 0,
                  maxOutput: Number(gateway.maxOutput) || 0
              }
            : undefined;
        const typed = secret.trim();
        const ends = expiresAt?.toISOString() ?? null;
        const named = showWorkspace && typedWorkspace.length > 0 ? typedWorkspace : undefined;
        const result = await runAction(
            () =>
                existing
                    ? actions.update({
                          id: existing.id,
                          name: name.trim(),
                          // Left blank means "leave the stored one alone". The
                          // field is write-only, so blank cannot mean erase.
                          secret: typed.length > 0 ? typed : undefined,
                          config,
                          // Blank on a key that named one stops naming it; blank
                          // on one that never did says nothing.
                          ...(provider === "anthropic"
                              ? { workspaceId: named ?? (storedWorkspace ? null : undefined) }
                              : {}),
                          expiresAt: ends
                      })
                    : actions.add({
                          provider,
                          name: name.trim(),
                          // A gateway that wants no token still needs a row, and
                          // the runtime sends a placeholder rather than nothing.
                          secret: entry?.isGateway && typed.length === 0 ? "unused-gateway" : typed,
                          config,
                          // Whose account it is, when a login said so. The only
                          // thing that tells two subscriptions apart in a table
                          // where every other column is identical.
                          ...(Object.keys(identity).length > 0 ? { identity } : {}),
                          ...(named ? { workspaceId: named } : {}),
                          expiresAt: ends
                      }),
            setError
        );
        setBusy(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            if (result.needsWorkspace) setAskedForWorkspace(true);
            return;
        }
        onSaved(result.warning);
    };

    const signin = assist?.signins.find((one) => one.slug === provider) ?? null;

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            {/* One dialog at a time: the form steps aside while the sign-in
                runs and comes back with what it produced filled in. */}
            {signingIn && signin && assist ? null : (
                <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto overscroll-contain">
                    <DialogHeader>
                        <DialogTitle>
                            {existing
                                ? t("modelKeys.editTitle", {
                                      thing: thing(action, t("modelKeys.providerKey"))
                                  })
                                : (action ?? t("modelKeys.addProviderKey"))}
                        </DialogTitle>
                        <DialogDescription>
                            {existing ? t("modelKeys.editHint") : adding}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-4">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("modelKeys.provider")}
                            {existing ? (
                                <span className="border-border bg-surface flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
                                    <IntegrationLogo
                                        slug={existing.provider}
                                        className="size-4 shrink-0"
                                    />
                                    <span
                                        className="min-w-0 truncate"
                                        title={entry?.name ?? existing.provider}
                                    >
                                        {entry?.name ?? existing.provider}
                                    </span>
                                </span>
                            ) : (
                                searchProviders ? (
                                    <ProviderSelect
                                        read={searchProviders}
                                        value={provider}
                                        selectedLabel={entry?.name}
                                        onChange={(slug, row) => {
                                            setProvider(slug);
                                            setPicked(row);
                                        }}
                                        disabled={busy}
                                    />
                                ) : (
                                    <SearchableSelect
                                        value={provider}
                                        onValueChange={setProvider}
                                        options={providers.map((row) => ({
                                            value: row.slug,
                                            label: row.name,
                                            icon: (
                                                <IntegrationLogo
                                                    slug={row.slug}
                                                    name={row.name}
                                                    className="size-4 shrink-0"
                                                />
                                            )
                                        }))}
                                        disabled={busy}
                                        placeholder={t("providerSelect.pick")}
                                        searchPlaceholder={t("providerSelect.search")}
                                        emptyText={t("providerSelect.none")}
                                        aria-label={t("providerSelect.pick")}
                                        className="h-9"
                                    />
                                )
                            )}
                        </label>

                        <label className="flex flex-col gap-1 text-sm">
                            {t("modelKeys.name")}
                            <Input
                                value={name}
                                placeholder={t("modelKeys.namePlaceholder")}
                                autoComplete="off"
                                aria-invalid={nameError !== null}
                                onChange={(event) => {
                                    setName(event.target.value);
                                    setTouched(true);
                                }}
                                onBlur={() => setTouched(true)}
                            />
                            <span
                                className={`text-xs ${nameError ? "text-danger" : "text-muted-foreground"}`}
                            >
                                {nameError ?? t("modelKeys.nameHint")}
                            </span>
                        </label>

                        {entry?.isGateway ? (
                            <>
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("modelKeys.endpoint")}
                                    <Input
                                        value={gateway.baseUrl}
                                        placeholder="https://gateway.example/v1" // i18n-ignore an example address
                                        onChange={(event) =>
                                            setGateway({ ...gateway, baseUrl: event.target.value })
                                        }
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("modelKeys.model")}
                                    <Input
                                        value={gateway.model}
                                        placeholder={t("modelKeys.modelPlaceholder")}
                                        onChange={(event) =>
                                            setGateway({ ...gateway, model: event.target.value })
                                        }
                                    />
                                </label>
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("modelKeys.context")}
                                        <Input
                                            value={gateway.context}
                                            inputMode="numeric"
                                            placeholder="200000"
                                            onChange={(event) =>
                                                setGateway({ ...gateway, context: event.target.value })
                                            }
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("modelKeys.maxOutput")}
                                        <Input
                                            value={gateway.maxOutput}
                                            inputMode="numeric"
                                            placeholder="32000"
                                            onChange={(event) =>
                                                setGateway({
                                                    ...gateway,
                                                    maxOutput: event.target.value
                                                })
                                            }
                                        />
                                    </label>
                                </div>
                                <p className="text-muted-foreground -mt-2 text-xs">
                                    {t("modelKeys.gatewayHint")}
                                </p>
                            </>
                        ) : null}

                        {/* The login, where the account has already been chosen. A
                            button outside this form would be asking somebody to pick
                            the agent twice for one credential - once on a card and
                            once here. */}
                        {signin && !existing ? (
                            <div className="border-primary/40 bg-primary/10 flex flex-wrap items-center gap-2 rounded-md border p-3">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm">{t("modelKeys.canSignIn")}</p>
                                    <p className="text-muted-foreground text-xs">
                                        {t("modelKeys.canSignInHint", {
                                            tool: signin.serves[0]?.label ?? t("modelKeys.theTool")
                                        })}
                                    </p>
                                </div>
                                <Button size="sm" onClick={() => setSigningIn(true)} disabled={busy}>
                                    <Wand2 className="size-4 shrink-0" />
                                    {t("modelKeys.signInHere")}
                                </Button>
                            </div>
                        ) : null}

                        <label className="flex flex-col gap-1 text-sm">
                            {entry?.apiKeyLabel ?? t("modelKeys.apiKey")}
                            <Input
                                type="password"
                                value={secret}
                                autoComplete="off"
                                placeholder={
                                    existing
                                        ? t("modelKeys.keepStored")
                                        : entry?.isGateway
                                          ? t("modelKeys.gatewayNoKey")
                                          : t("modelKeys.pasteKey")
                                }
                                onChange={(event) => setSecret(event.target.value)}
                            />
                            <span className="text-muted-foreground text-xs">
                                {t("modelKeys.encrypted")}{" "}
                                {entry?.checkable
                                    ? t("modelKeys.validated", { provider: entry.name })
                                    : t("modelKeys.provenByRun")}
                            </span>
                            {entry?.apiKeyHelp ? (
                                <span className="text-muted-foreground text-xs">
                                    {entry.apiKeyHelp}
                                </span>
                            ) : null}
                            {/* Said here rather than only on the row in the picker,
                                because this is the moment somebody is deciding
                                whether to go and make an account at all. */}
                            {entry?.freeTier && !existing ? (
                                <span className="text-success text-xs">
                                    {entry.freeTier.kind === "free"
                                        ? t("modelKeys.freeTier")
                                        : t("modelKeys.freeTrial")}{" "}
                                    {entry.freeTier.note}
                                </span>
                            ) : null}
                        </label>

                        {showWorkspace ? (
                            <label className="flex flex-col gap-1 text-sm">
                                {t("modelKeys.workspaceId")}
                                <Input
                                    value={workspace}
                                    placeholder="wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" // i18n-ignore the documented example ID
                                    autoComplete="off"
                                    spellCheck={false}
                                    aria-invalid={workspaceError !== null}
                                    onChange={(event) => setWorkspace(event.target.value)}
                                />
                                <span
                                    className={`text-xs ${workspaceError ? "text-danger" : "text-muted-foreground"}`}
                                >
                                    {workspaceError ?? t("modelKeys.workspaceHint")}
                                </span>
                            </label>
                        ) : null}

                        <label className="flex flex-col gap-1 text-sm">
                            {t("modelKeys.expires")}
                            <DateInput
                                mode="date"
                                value={expiry}
                                min={earliestExpiry()}
                                onChange={(event) => setExpiry(event.target.value)}
                            />
                            <span className="text-muted-foreground text-xs">
                                {t("modelKeys.expiryHint", {
                                    provider: entry?.name ?? t("modelKeys.theProvider")
                                })}
                            </span>
                            {expiry ? (
                                <button
                                    type="button"
                                    onClick={() => setExpiry("")}
                                    className="text-muted-foreground hover:text-foreground self-start text-xs underline"
                                >
                                    {t("modelKeys.clearDate")}
                                </button>
                            ) : null}
                        </label>

                        {existing ? null : (
                            <p className="text-muted-foreground text-xs">
                                {t("modelKeys.addedAtBottom")}
                            </p>
                        )}

                        {error ? <p className="text-danger text-sm">{error}</p> : null}

                        <div className="flex items-center justify-end gap-2">
                            {entry?.createUrl && !existing ? (
                                <a
                                    href={entry.createUrl}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="text-muted-foreground hover:text-foreground me-auto text-xs"
                                >
                                    {t("modelKeys.createAt", { provider: entry.name })}
                                </a>
                            ) : null}
                            <Button variant="ghost" onClick={onClose} disabled={busy}>
                                {tcommon("actions.cancel")}
                            </Button>
                            <Button
                                onClick={() => void submit()}
                                disabled={busy || !ready || unchanged}
                            >
                                {busy
                                    ? t("modelKeys.checking")
                                    : existing
                                      ? t("modelKeys.save")
                                      : (action ?? t("modelKeys.addKey"))}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            )}

            {/* Fills the form rather than saving behind it: what the login
                produces lands in the field, and the person still presses the
                button that adds it. One write, one confirmation, one place the
                name and the order are decided. */}
            {signingIn && signin && assist ? (
                <SigninDialog
                    signin={signin}
                    actions={{
                        ...assist.actions,
                        save: async (value: string, found, chosen: string) => {
                            setSecret(value);
                            setIdentity(found as Record<string, string>);
                            if (!name.trim()) setName(chosen);
                            return {};
                        }
                    }}
                    onClose={() => setSigningIn(false)}
                    onDone={() => setSigningIn(false)}
                />
            ) : null}
        </Dialog>
    );
}

/** What this screen calls the thing it lists, from the words on its button:
 *  everything after the verb ("Add account" is an account, "Añadir cuenta" a
 *  cuenta), or `fallback` when the screen gave none. */
function thing(action: string | undefined, fallback: string): string {
    return action ? action.replace(/^\S+\s+/, "").toLowerCase() : fallback;
}

/** The gateway settings a stored key carries, as the form's strings. */
function readGateway(key: ModelKeyView | null): GatewayForm {
    if (!key) return EMPTY_GATEWAY;
    const config = key.config;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const number = (value: unknown) =>
        typeof value === "number" && value > 0 ? String(value) : "";
    return {
        baseUrl: text(config.baseUrl),
        model: text(config.model),
        context: number(config.context),
        maxOutput: number(config.maxOutput)
    };
}
