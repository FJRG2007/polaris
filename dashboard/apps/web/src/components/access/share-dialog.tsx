"use client";

/**
 * Handing one thing over, from wherever it is being handed over.
 *
 * The shape every widely used share dialog converged on (Google Drive's, and
 * Notion's and Figma's after it): one box that finds anybody it may go to,
 * "People with access" underneath with a role on every row, and "General access"
 * for the link. Picking somebody stages them; Share writes them all at once.
 *
 * Built to be shared with thousands: the list is paged and searched on the
 * server, drawn virtualized, and a team or a role is one row however many people
 * it reaches. The "only sometimes" half - days, hours, uses - exists only where
 * it means anything (`bounded`), and is reached from a row's role menu.
 */

import * as core from "@polaris/core";
import type { GrantPage, GrantView } from "@/lib/access/grants";
import { useConfirm } from "@/components/confirm-dialog";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useDisplayFormat } from "@/components/display-format";
import { createPortal } from "react-dom";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AccessLog } from "@/components/access/access-log";
import { Avatar } from "@/components/avatar";
import {
    EMPTY_LINK_ADVANCED,
    LinkAdvancedFields,
    linkAddressRules,
    type LinkAdvancedValue
} from "@/components/link-advanced-fields";
import {
    EMPTY_LIMITS,
    LimitsFields,
    badFence,
    boundsOf,
    describeGrant,
    limitsOf,
    type LimitsValue
} from "@/components/access/share-limits";
import {
    ArrowLeft,
    Building2,
    Copy,
    Globe,
    History,
    Link2,
    Loader2,
    Lock,
    Search,
    Shield,
    Users,
    X
} from "lucide-react";
import {
    findShareTargetsAction,
    grantPageAction,
    revokeShareAction,
    setLinkAudienceAction,
    shareLinkAction,
    shareManyAction,
    shareSetupAction,
    updateShareAction,
    type ShareSetup,
    type ShareTarget
} from "@/app/(app)/access-actions";
import {
    Badge,
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    Textarea,
    cn,
    useToast
} from "@polaris/ui";

/** The capabilities this dialog has words for, as `share.capabilities.<id>`. */
const CAPABILITIES = new Set(["guest", "member", "admin", "view", "control", "edit"]);

/** What a standing looks like beside a row. Only `live` is quiet. */
const STANDING_TONE: Record<core.GrantStanding, "success" | "warning" | "neutral"> = {
    live: "success",
    waiting: "neutral",
    expired: "neutral",
    closed: "warning",
    spent: "neutral",
    elsewhere: "warning",
    signin: "neutral",
    denied: "warning",
    password: "neutral"
};

/** One row of "People with access", in pixels, for the virtualizer. */
const ROW_HEIGHT = 56;
/** The tallest the suggestion list grows, room permitting. */
const LIST_HEIGHT = 256;
/** Values the role menu uses for what is not a role. */
const LIMITS = "__limits";
const REMOVE = "__remove";

const AUDIENCE_ICON = { restricted: Lock, org: Building2, anyone: Globe } as const;

export function ShareDialog({
    open,
    onOpenChange,
    subject,
    subjectId,
    name,
    bounded = false,
    principals = core.subjectPrincipals(subject),
    extra
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    subject: core.GrantSubject;
    subjectId: string;
    /** What is being shared, in the words on the screen behind this. */
    name: string;
    /** Whether hours, dates and a number of uses mean anything here. They do for
     *  a door and a camera; they do not for a conversation. */
    bounded?: boolean;
    /** Who it may be shared with, where the app keeps the others itself. */
    principals?: readonly core.GrantPrincipal[];
    /** Anything the thing being shared has of its own, under the grants. */
    extra?: ReactNode;
}) {
    const toast = useToast();
    // Read through a ref where an effect needs it: opening the dialog must not
    // depend on whether the toast's identity is stable.
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const t = useTranslations("components");
    const locale = useLocale();
    const format = useDisplayFormat();
    const dayNames = useMemo(() => core.weekdayNames(locale, "short"), [locale]);
    const weekOrder = useMemo(() => core.weekOrderFrom(format.weekStartsOn), [format.weekStartsOn]);
    const [confirm, confirmDialog] = useConfirm();
    const capabilityLabel = (one: string) =>
        CAPABILITIES.has(one)
            ? t(`share.capabilities.${one}.label` as NamespaceKey<"components">)
            : one;
    const actionLabel = (one: string) => t(`share.actions.${one}` as NamespaceKey<"components">);
    const capabilities = core.GRANT_CAPABILITIES[subject] as readonly string[];
    const linkable = core.isGrantLinkSubject(subject);
    const linkCapabilities: readonly string[] = linkable ? core.linkCapabilities(subject) : [];

    const [setup, setSetup] = useState<ShareSetup | null>(null);
    const [history, setHistory] = useState(false);
    const [logGrant, setLogGrant] = useState<GrantView | null>(null);

    // --- People with access: paged, searched, virtualized ---------------------
    const [rows, setRows] = useState<GrantView[] | null>(null);
    const [total, setTotal] = useState(0);
    const [cursor, setCursor] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [paging, setPaging] = useState(false);
    const [pageFailed, setPageFailed] = useState(false);
    const generation = useRef(0);

    const loadPeople = useCallback(
        async (search: string, after: string | null) => {
            const mine = after ? generation.current : ++generation.current;
            setPaging(true);
            const answer = await grantPageAction(subject, subjectId, { search, cursor: after });
            // A newer search has been typed since: this answer is for a list
            // nobody is looking at any more.
            if (mine !== generation.current) return;
            setPaging(false);
            if (answer.error || !answer.page) {
                setPageFailed(true);
                if (!after) setRows([]);
                return;
            }
            const page: GrantPage = answer.page;
            setPageFailed(false);
            setRows((held) => (after ? [...(held ?? []), ...page.grants] : page.grants));
            setTotal(page.total);
            setCursor(page.nextCursor);
        },
        [subject, subjectId]
    );

    // --- General access: the links ---------------------------------------------
    const [links, setLinks] = useState<GrantView[] | null>(null);
    const loadLinks = useCallback(async () => {
        if (!linkable) return setLinks([]);
        const answer = await grantPageAction(subject, subjectId, { links: true });
        setLinks(answer.page?.grants ?? []);
    }, [linkable, subject, subjectId]);

    useEffect(() => {
        if (!open) return;
        setSetup(null);
        setRows(null);
        setLinks(null);
        setFilter("");
        setHistory(false);
        void shareSetupAction(subject, subjectId).then((answer) => {
            if (answer.error) toastRef.current.show({ title: answer.error });
            setSetup(answer.setup ?? null);
        });
        void loadPeople("", null);
        void loadLinks();
    }, [open, subject, subjectId, loadPeople, loadLinks]);

    // Searching who has access is on the server, after a beat.
    const firstFilter = useRef(true);
    useEffect(() => {
        if (!open) return;
        if (firstFilter.current) {
            firstFilter.current = false;
            return;
        }
        const timer = setTimeout(() => void loadPeople(filter, null), 250);
        return () => clearTimeout(timer);
    }, [filter, open, loadPeople]);

    // --- The add box -------------------------------------------------------------
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<ShareTarget[]>([]);
    const [searching, setSearching] = useState(false);
    const [active, setActive] = useState(0);
    const [staged, setStaged] = useState<ShareTarget[]>([]);
    const [capability, setCapability] = useState(capabilities[0] ?? "");
    const reachable = core.grantActions(subject, capability, []);
    const [actions, setActions] = useState<string[]>(reachable);
    const [limits, setLimits] = useState<LimitsValue>(EMPTY_LIMITS);
    const [notify, setNotify] = useState(true);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const searchSeq = useRef(0);
    const pickCapability = (next: string): void => {
        setCapability(next);
        setActions(core.grantActions(subject, next, []));
    };
    const noAction = reachable.length > 0 && !reachable.some((one) => actions.includes(one));

    useEffect(() => {
        const term = query.trim();
        if (term.length < 2) {
            // The same empty list, not a new one: a fresh array here is a
            // render, and a render runs this again.
            setFound((held) => (held.length === 0 ? held : []));
            setSearching(false);
            return;
        }
        setSearching(true);
        const mine = ++searchSeq.current;
        const timer = setTimeout(async () => {
            const answer = await findShareTargetsAction(subject, subjectId, term);
            if (mine !== searchSeq.current) return;
            setSearching(false);
            setActive(0);
            setFound(
                (answer.targets ?? []).filter(
                    (one) =>
                        principals.includes(one.type) &&
                        !staged.some((held) => held.type === one.type && held.id === one.id)
                )
            );
        }, 250);
        return () => clearTimeout(timer);
        // `principals` by its contents: a caller's default is a new array on
        // every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, subject, subjectId, principals.join(","), staged]);

    const full = staged.length >= core.MAX_SHARE_TARGETS;
    const stage = (target: ShareTarget): void => {
        if (full) return;
        setStaged((held) => [...held, target]);
        setQuery("");
        setFound([]);
    };

    // The suggestions are drawn over the dialog rather than inside it, so a
    // short window clips neither them nor the dialog's own scroll.
    const addBox = useRef<HTMLDivElement>(null);
    const [listAt, setListAt] = useState<CSSProperties | null>(null);
    const listing = found.length > 0 && !full;
    useLayoutEffect(() => {
        if (!listing) {
            setListAt(null);
            return;
        }
        const measure = (): void => {
            const box = addBox.current?.getBoundingClientRect();
            if (!box) return;
            const below = window.innerHeight - box.bottom - 12;
            const above = box.top - 12;
            const up = below < LIST_HEIGHT && above > below;
            setListAt({
                left: box.left,
                width: box.width,
                maxHeight: Math.max(Math.min(LIST_HEIGHT, up ? above : below), 0),
                ...(up ? { bottom: window.innerHeight - box.top + 4 } : { top: box.bottom + 4 })
            });
        };
        measure();
        window.addEventListener("scroll", measure, true);
        window.addEventListener("resize", measure);
        return () => {
            window.removeEventListener("scroll", measure, true);
            window.removeEventListener("resize", measure);
        };
    }, [listing, staged.length]);
    const unstageAll = (): void => {
        setStaged([]);
        setLimits(EMPTY_LIMITS);
        setMessage("");
        setNotify(true);
        pickCapability(capabilities[0] ?? "");
    };

    const share = async (): Promise<void> => {
        if (staged.length === 0 || noAction || badFence(subject, limits)) return;
        setBusy(true);
        const answer = await shareManyAction(subject, subjectId, {
            targets: staged.map((one) => ({ principalType: one.type, principalId: one.id })),
            grant: {
                capability,
                actions: reachable.filter((one) => actions.includes(one)),
                ...boundsOf(subject, limits)
            },
            notify,
            message
        });
        setBusy(false);
        if (answer.error) {
            toast.show({ title: answer.error });
            return;
        }
        unstageAll();
        toast.show({ title: t("share.shared") });
        void loadPeople(filter, null);
    };

    // --- A row's role, limits and removal: optimistic, rolled back -------------
    const [editing, setEditing] = useState<{ grant: GrantView; value: LimitsValue } | null>(null);

    const replaceRow = (list: GrantView[] | null, next: GrantView) =>
        (list ?? []).map((one) => (one.id === next.id ? next : one));

    const changeRole = async (grant: GrantView, next: string): Promise<void> => {
        if (next === grant.capability) return;
        const isLink = grant.principalType === core.LINK_PRINCIPAL;
        const before = isLink ? links : rows;
        const changed = { ...grant, capability: next, actions: [] };
        (isLink ? setLinks : setRows)((held) => replaceRow(held, changed));
        const answer = await updateShareAction(subject, subjectId, grant.id, {
            capability: next,
            actions: [],
            note: grant.note,
            timeZone: grant.schedule.timeZone,
            ...boundsOf(subject, limitsOf(grant))
        });
        if (answer.error) {
            (isLink ? setLinks : setRows)(before);
            toast.show({ title: answer.error });
            return;
        }
        toast.show({ title: t("share.changed") });
    };

    const saveLimits = async (): Promise<void> => {
        if (!editing || badFence(subject, editing.value)) return;
        const { grant, value } = editing;
        setBusy(true);
        const answer = await updateShareAction(subject, subjectId, grant.id, {
            capability: grant.capability,
            actions: grant.actions,
            note: grant.note,
            timeZone: grant.schedule.timeZone,
            ...boundsOf(subject, value)
        });
        setBusy(false);
        if (answer.error) {
            toast.show({ title: answer.error });
            return;
        }
        setEditing(null);
        toast.show({ title: t("share.changed") });
        void (grant.principalType === core.LINK_PRINCIPAL ? loadLinks() : loadPeople(filter, null));
    };

    /** Who a grant is to, in words: a link has nobody, so it is called one. */
    const who = (grant: GrantView): string =>
        grant.principalType === core.LINK_PRINCIPAL ? t("share.linkName") : grant.principalName;

    const revoke = async (grant: GrantView): Promise<void> => {
        const sure = await confirm({
            title: t("share.stopTitle", { name: who(grant) }),
            description: t("share.stopBody", { who: who(grant), what: name }),
            confirmLabel: t("share.stop"),
            danger: true
        });
        if (!sure) return;
        const isLink = grant.principalType === core.LINK_PRINCIPAL;
        const before = isLink ? links : rows;
        const beforeTotal = total;
        (isLink ? setLinks : setRows)((held) => (held ?? []).filter((one) => one.id !== grant.id));
        if (!isLink) setTotal((count) => Math.max(0, count - 1));
        const answer = await revokeShareAction(subject, subjectId, grant.id);
        if (answer.error) {
            (isLink ? setLinks : setRows)(before);
            setTotal(beforeTotal);
            toast.show({ title: answer.error });
            return;
        }
        toast.show({ title: t("share.takenBack") });
    };

    const roleMenu = (grant: GrantView) => {
        const isLink = grant.principalType === core.LINK_PRINCIPAL;
        const ladder = isLink ? linkCapabilities : capabilities;
        return (
            <Select
                aria-label={t("share.roleOf", { name: who(grant) })}
                className="w-auto shrink-0"
                value={grant.capability}
                onValueChange={(next) => {
                    if (next === LIMITS) setEditing({ grant, value: limitsOf(grant) });
                    else if (next === REMOVE) void revoke(grant);
                    else void changeRole(grant, next);
                }}
                options={[
                    ...ladder.map((one) => ({ value: one, label: capabilityLabel(one) })),
                    ...(bounded ? [{ value: LIMITS, label: t("share.limits") }] : []),
                    { value: REMOVE, label: t("share.removeAccess") }
                ]}
            />
        );
    };

    // --- Virtualized list ----------------------------------------------------------
    const scroller = useRef<HTMLDivElement>(null);
    const people = rows ?? [];
    const virtualizer = useVirtualizer({
        count: people.length,
        getScrollElement: () => scroller.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 6,
        initialRect: { width: 480, height: ROW_HEIGHT * 5 }
    });
    const items = virtualizer.getVirtualItems();
    const lastIndex = items[items.length - 1]?.index ?? -1;
    useEffect(() => {
        if (cursor && !paging && !pageFailed && lastIndex >= people.length - 5) {
            void loadPeople(filter, cursor);
        }
    }, [cursor, paging, pageFailed, lastIndex, people.length, filter, loadPeople]);

    // --- Links ------------------------------------------------------------------------
    const [draftAudience, setDraftAudience] = useState<core.LinkAudience | null>(null);
    const [linkCapability, setLinkCapability] = useState(linkCapabilities[0] ?? "");
    const [linkRules, setLinkRules] = useState<LinkAdvancedValue>(EMPTY_LINK_ADVANCED);
    const [madeLink, setMadeLink] = useState<string | null>(null);
    const audiences: core.LinkAudience[] = [
        "restricted",
        ...(setup?.org ? (["org"] as const) : []),
        "anyone"
    ];
    const audienceOption = (one: core.LinkAudience) => {
        const Icon = AUDIENCE_ICON[one];
        return {
            value: one,
            icon: <Icon className="size-4 shrink-0" aria-hidden />,
            label: t(`share.audiences.${one}.label`, { org: setup?.org?.name ?? "" })
        };
    };

    const makeLink = async (): Promise<void> => {
        if (!draftAudience) return;
        setBusy(true);
        const answer = await shareLinkAction(subject, subjectId, {
            capability: linkCapability,
            actions: core.grantActions(subject, linkCapability, []),
            audience: draftAudience,
            ...(linkRules.expiresAt ? { endsAt: new Date(linkRules.expiresAt).toISOString() } : {}),
            ...(linkRules.maxUses ? { maxUses: Number(linkRules.maxUses) } : {}),
            ...(linkRules.password && draftAudience !== "restricted"
                ? { password: linkRules.password }
                : {}),
            ...linkAddressRules(linkRules)
        });
        setBusy(false);
        if (answer.error || !answer.link) {
            toast.show({ title: answer.error ?? t("share.needAction") });
            return;
        }
        setMadeLink(answer.link);
        setDraftAudience(null);
        setLinkRules(EMPTY_LINK_ADVANCED);
        void loadLinks();
    };

    const changeAudience = async (grant: GrantView, next: core.LinkAudience): Promise<void> => {
        if (next === grant.audience) return;
        const before = links;
        setLinks((held) => replaceRow(held, { ...grant, audience: next }));
        const answer = await setLinkAudienceAction(subject, subjectId, grant.id, next);
        if (answer.error) {
            setLinks(before);
            toast.show({ title: answer.error });
        }
    };

    const copy = async (text: string): Promise<void> => {
        try {
            await navigator.clipboard.writeText(text);
            toast.show({ title: t("share.copied") });
        } catch {
            // A browser that refuses the clipboard still shows the link.
        }
    };

    const describe = (grant: GrantView) => describeGrant(grant, weekOrder, t, dayNames);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle className="min-w-0 truncate" title={name}>
                        {t("share.title", { name })}
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        {bounded ? t("share.introBounded") : t("share.intro")}
                    </DialogDescription>
                </DialogHeader>

                {history ? (
                    <div className="flex min-w-0 flex-col gap-3">
                        <Button
                            variant="ghost"
                            className="self-start"
                            onClick={() => {
                                setHistory(false);
                                setLogGrant(null);
                            }}
                        >
                            <ArrowLeft className="size-4 shrink-0" aria-hidden />
                            {t("share.back")}
                        </Button>
                        <AccessLog
                            subject={subject}
                            subjectId={subjectId}
                            grantId={logGrant?.id ?? null}
                            grantLabel={logGrant ? who(logGrant) : ""}
                            onClearGrant={() => setLogGrant(null)}
                        />
                    </div>
                ) : editing ? (
                    <section
                        className="flex min-w-0 flex-col gap-3"
                        aria-label={t("share.limitsOf", { name: who(editing.grant) })}
                    >
                        <p className="truncate text-[13px] font-medium text-foreground">
                            {t("share.limitsOf", { name: who(editing.grant) })}
                        </p>
                        <LimitsFields
                            subject={subject}
                            bounded={bounded}
                            value={{ ...editing.value, limited: true }}
                            onChange={(value) => setEditing({ ...editing, value })}
                            located={setup?.located ?? null}
                            idPrefix="share-edit"
                        />
                        <div className="flex justify-end gap-2">
                            <Button variant="ghost" onClick={() => setEditing(null)}>
                                {t("share.cancel")}
                            </Button>
                            <Button
                                disabled={busy || badFence(subject, editing.value)}
                                onClick={() => void saveLimits()}
                            >
                                {busy ? (
                                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                                ) : null}
                                {t("share.save")}
                            </Button>
                        </div>
                    </section>
                ) : (
                    <>
                        {/* The one box: anybody this may go to, in one ranked list. */}
                        <div className="relative flex min-w-0 flex-col gap-2">
                            <label className="sr-only" htmlFor="share-add">
                                {t("share.addLabel")}
                            </label>
                            <div
                                ref={addBox}
                                className="flex min-w-0 flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 focus-within:ring-2 focus-within:ring-primary/40"
                            >
                                {staged.map((one) => (
                                    <span
                                        key={`${one.type}:${one.id}`}
                                        className="flex min-w-0 max-w-full items-center gap-1 rounded-full bg-surface-hover py-0.5 pl-1 pr-1.5 text-[12px] text-foreground"
                                    >
                                        <TargetFace target={one} size={18} />
                                        <span className="min-w-0 truncate" title={one.name}>
                                            {one.name}
                                        </span>
                                        <button
                                            type="button"
                                            aria-label={t("share.unstage", { name: one.name })}
                                            title={t("share.unstage", { name: one.name })}
                                            onClick={() =>
                                                setStaged((held) => held.filter((x) => x !== one))
                                            }
                                            className="rounded-full p-0.5 hover:bg-surface"
                                        >
                                            <X className="size-3 shrink-0" aria-hidden />
                                        </button>
                                    </span>
                                ))}
                                <input
                                    id="share-add"
                                    role="combobox"
                                    aria-expanded={listing}
                                    aria-controls="share-add-list"
                                    aria-autocomplete="list"
                                    aria-activedescendant={
                                        found[active] ? `share-add-${active}` : undefined
                                    }
                                    autoComplete="off"
                                    className="min-w-[8rem] flex-1 bg-transparent py-1 text-[13px] text-foreground outline-none placeholder:text-foreground-subtle"
                                    placeholder={staged.length ? "" : t("share.addPlaceholder")}
                                    value={query}
                                    onChange={(event) => setQuery(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "ArrowDown" && found.length) {
                                            event.preventDefault();
                                            setActive((at) => (at + 1) % found.length);
                                        } else if (event.key === "ArrowUp" && found.length) {
                                            event.preventDefault();
                                            setActive(
                                                (at) => (at - 1 + found.length) % found.length
                                            );
                                        } else if (event.key === "Enter" && found[active]) {
                                            event.preventDefault();
                                            stage(found[active]);
                                        } else if (event.key === "Escape" && found.length) {
                                            event.stopPropagation();
                                            setFound([]);
                                        } else if (
                                            event.key === "Backspace" &&
                                            !query &&
                                            staged.length
                                        ) {
                                            setStaged((held) => held.slice(0, -1));
                                        }
                                    }}
                                />
                                {searching ? (
                                    <Loader2
                                        className="size-4 shrink-0 animate-spin text-foreground-subtle"
                                        aria-label={t("share.searching")}
                                    />
                                ) : null}
                            </div>
                            {full ? (
                                <p className="text-[12px] text-muted-foreground">
                                    {t("share.tooMany", { count: core.MAX_SHARE_TARGETS })}
                                </p>
                            ) : listing ? (
                                listAt ? (
                                    createPortal(
                                        <ul
                                            id="share-add-list"
                                            role="listbox"
                                            style={listAt}
                                            className="pointer-events-auto fixed z-[60] overflow-y-auto rounded-md border border-border bg-surface-raised p-1 shadow-lg"
                                        >
                                            {found.map((one, index) => (
                                                <li
                                                    key={`${one.type}:${one.id}`}
                                                    id={`share-add-${index}`}
                                                    role="option"
                                                    aria-selected={index === active}
                                                    onMouseDown={(event) => event.preventDefault()}
                                                    onClick={() => stage(one)}
                                                    onMouseEnter={() => setActive(index)}
                                                    className={cn(
                                                        "flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5",
                                                        index === active && "bg-surface-hover"
                                                    )}
                                                >
                                                    <TargetFace target={one} size={24} />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate text-[13px] text-foreground">
                                                            {one.name}
                                                        </span>
                                                        {one.detail ? (
                                                            <span className="block truncate text-[12px] text-muted-foreground">
                                                                {one.detail}
                                                            </span>
                                                        ) : null}
                                                    </span>
                                                    <span className="shrink-0 text-[11px] text-foreground-subtle">
                                                        {t(`share.kinds.${one.type}`)}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>,
                                        document.body
                                    )
                                ) : null
                            ) : query.trim().length >= 2 && !searching ? (
                                <p className="text-[12px] text-muted-foreground">
                                    {t("share.noMatch")}
                                </p>
                            ) : null}
                        </div>

                        {staged.length > 0 ? (
                            <section
                                className="flex min-w-0 flex-col gap-3"
                                aria-label={t("share.more")}
                            >
                                <div className="flex min-w-0 flex-col gap-1">
                                    <label
                                        className="text-[12px] text-muted-foreground"
                                        htmlFor="share-what"
                                    >
                                        {t("share.can")}
                                    </label>
                                    <Select
                                        id="share-what"
                                        aria-label={t("share.can")}
                                        value={capability}
                                        onValueChange={pickCapability}
                                        options={capabilities.map((one) => ({
                                            value: one,
                                            label: capabilityLabel(one)
                                        }))}
                                    />
                                </div>
                                {reachable.length > 1 ? (
                                    <fieldset className="flex flex-col gap-1">
                                        <legend className="text-[12px] text-muted-foreground">
                                            {t("share.actionsLabel")}
                                        </legend>
                                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                                            {reachable.map((one) => (
                                                <label
                                                    key={one}
                                                    className="flex items-center gap-2 text-[13px] text-foreground"
                                                >
                                                    <Checkbox
                                                        checked={actions.includes(one)}
                                                        onChange={(event) =>
                                                            setActions((now) =>
                                                                event.target.checked
                                                                    ? [...now, one]
                                                                    : now.filter(
                                                                          (held) => held !== one
                                                                      )
                                                            )
                                                        }
                                                    />
                                                    {actionLabel(one)}
                                                </label>
                                            ))}
                                        </div>
                                    </fieldset>
                                ) : null}
                                <LimitsFields
                                    subject={subject}
                                    bounded={bounded}
                                    value={limits}
                                    onChange={setLimits}
                                    located={setup?.located ?? null}
                                    idPrefix="share"
                                />
                                {staged.some((one) => one.type === "user") ? (
                                    <>
                                        <label className="flex items-center gap-2 text-[13px] text-foreground">
                                            <Checkbox
                                                checked={notify}
                                                onChange={(event) =>
                                                    setNotify(event.target.checked)
                                                }
                                            />
                                            {t("share.notify")}
                                        </label>
                                        {notify ? (
                                            <Textarea
                                                aria-label={t("share.message")}
                                                placeholder={t("share.messagePlaceholder")}
                                                value={message}
                                                maxLength={500}
                                                rows={2}
                                                onChange={(event) => setMessage(event.target.value)}
                                            />
                                        ) : null}
                                    </>
                                ) : null}
                                <div className="flex justify-end gap-2">
                                    <Button variant="ghost" onClick={unstageAll}>
                                        {t("share.cancel")}
                                    </Button>
                                    <Button
                                        disabled={busy || noAction || badFence(subject, limits)}
                                        aria-disabled={
                                            busy || noAction || badFence(subject, limits)
                                        }
                                        onClick={() => void share()}
                                    >
                                        {busy ? (
                                            <Loader2
                                                className="size-4 shrink-0 animate-spin"
                                                aria-hidden
                                            />
                                        ) : null}
                                        {t("share.share")}
                                    </Button>
                                </div>
                            </section>
                        ) : (
                            <>
                                <section
                                    className="flex min-w-0 flex-col gap-2"
                                    aria-label={t("share.peopleWithAccess")}
                                >
                                    <div className="flex min-w-0 items-center justify-between gap-2">
                                        <h3 className="truncate text-[13px] font-medium text-foreground">
                                            {t("share.peopleWithAccess")}
                                        </h3>
                                        {rows !== null ? (
                                            <span className="shrink-0 text-[12px] text-muted-foreground">
                                                {t("share.peopleCount", { count: total })}
                                            </span>
                                        ) : null}
                                    </div>
                                    {total > 5 || filter ? (
                                        <div className="relative">
                                            <Search
                                                className="pointer-events-none absolute left-2 top-1/2 size-4 shrink-0 -translate-y-1/2 text-foreground-subtle"
                                                aria-hidden
                                            />
                                            <Input
                                                className="pl-8"
                                                aria-label={t("share.searchAccess")}
                                                placeholder={t("share.searchAccess")}
                                                value={filter}
                                                onChange={(event) => setFilter(event.target.value)}
                                            />
                                        </div>
                                    ) : null}
                                    {setup ? (
                                        <OwnerRow setup={setup} />
                                    ) : (
                                        <Skeleton className="h-10 w-full" />
                                    )}
                                    {rows === null ? (
                                        <>
                                            <Skeleton className="h-12 w-full" />
                                            <Skeleton className="h-12 w-full" />
                                        </>
                                    ) : people.length === 0 ? (
                                        <p className="px-1 text-[13px] text-muted-foreground">
                                            {filter ? t("share.nobodyMatches") : t("share.none")}
                                        </p>
                                    ) : (
                                        <div
                                            ref={scroller}
                                            className="max-h-72 min-w-0 overflow-y-auto"
                                            role="list"
                                        >
                                            <div
                                                style={{
                                                    height: virtualizer.getTotalSize(),
                                                    position: "relative"
                                                }}
                                            >
                                                {items.map((item) => {
                                                    const grant = people[item.index];
                                                    if (!grant) return null;
                                                    const line = describe(grant);
                                                    return (
                                                        <div
                                                            key={grant.id}
                                                            role="listitem"
                                                            data-index={item.index}
                                                            className="absolute left-0 right-0 flex min-w-0 items-center gap-3 px-1"
                                                            style={{
                                                                top: item.start,
                                                                height: ROW_HEIGHT
                                                            }}
                                                        >
                                                            <PrincipalFace grant={grant} />
                                                            <div className="min-w-0 flex-1">
                                                                <p className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
                                                                    <span
                                                                        className="min-w-0 truncate"
                                                                        title={who(grant)}
                                                                    >
                                                                        {who(grant)}
                                                                    </span>
                                                                    {grant.standing !== "live" ? (
                                                                        <Badge
                                                                            variant={
                                                                                STANDING_TONE[
                                                                                    grant.standing
                                                                                ]
                                                                            }
                                                                        >
                                                                            {t(
                                                                                `share.standings.${grant.standing}`
                                                                            )}
                                                                        </Badge>
                                                                    ) : grant.schedule.endsAt ? (
                                                                        <Badge variant="neutral">
                                                                            {t("share.untilOnly", {
                                                                                to: grant.schedule.endsAt.slice(
                                                                                    0,
                                                                                    10
                                                                                )
                                                                            })}
                                                                        </Badge>
                                                                    ) : null}
                                                                </p>
                                                                <p
                                                                    className="truncate text-[12px] text-muted-foreground"
                                                                    title={[
                                                                        grant.contact ||
                                                                            grant.orgName,
                                                                        line
                                                                    ]
                                                                        .filter(Boolean)
                                                                        .join(" - ")}
                                                                >
                                                                    {[
                                                                        grant.contact ||
                                                                            grant.orgName,
                                                                        line
                                                                    ]
                                                                        .filter(Boolean)
                                                                        .join(" - ")}
                                                                </p>
                                                            </div>
                                                            {bounded ? (
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    aria-label={t(
                                                                        "share.log.ofKey",
                                                                        { name: who(grant) }
                                                                    )}
                                                                    title={t("share.log.ofKey", {
                                                                        name: who(grant)
                                                                    })}
                                                                    onClick={() => {
                                                                        setLogGrant(grant);
                                                                        setHistory(true);
                                                                    }}
                                                                >
                                                                    <History
                                                                        className="size-4 shrink-0"
                                                                        aria-hidden
                                                                    />
                                                                </Button>
                                                            ) : null}
                                                            {roleMenu(grant)}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                    {pageFailed && rows !== null && rows.length > 0 ? (
                                        <div className="flex min-w-0 items-center gap-2">
                                            <p
                                                role="alert"
                                                className="min-w-0 flex-1 text-[12px] text-danger-ink"
                                            >
                                                {t("share.loadFailed")}
                                            </p>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                disabled={paging}
                                                onClick={() => void loadPeople(filter, cursor)}
                                            >
                                                {t("share.retry")}
                                            </Button>
                                        </div>
                                    ) : null}
                                </section>

                                <section
                                    className="flex min-w-0 flex-col gap-2"
                                    aria-label={t("share.general")}
                                >
                                    <h3 className="text-[13px] font-medium text-foreground">
                                        {t("share.general")}
                                    </h3>
                                    {links === null ? (
                                        <Skeleton className="h-12 w-full" />
                                    ) : (
                                        <>
                                            {links.map((grant) => {
                                                const Icon = AUDIENCE_ICON[grant.audience];
                                                const line = describe(grant);
                                                return (
                                                    <div
                                                        key={grant.id}
                                                        className="flex min-w-0 items-start gap-3 px-1 py-1"
                                                    >
                                                        <span className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-foreground-subtle">
                                                            <Icon
                                                                className="size-4 shrink-0"
                                                                aria-hidden
                                                            />
                                                        </span>
                                                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                                                            <Select
                                                                aria-label={t("share.audienceOf")}
                                                                className="w-full sm:w-auto"
                                                                value={grant.audience}
                                                                onValueChange={(next) =>
                                                                    void changeAudience(
                                                                        grant,
                                                                        next as core.LinkAudience
                                                                    )
                                                                }
                                                                options={audiences.map(
                                                                    audienceOption
                                                                )}
                                                            />
                                                            <p
                                                                className="truncate text-[12px] text-muted-foreground"
                                                                title={line}
                                                            >
                                                                {t(
                                                                    `share.audiences.${grant.audience}.hint`,
                                                                    { org: setup?.org?.name ?? "" }
                                                                )}
                                                                {line ? ` - ${line}` : ""}
                                                            </p>
                                                            {grant.standing !== "live" ||
                                                            grant.password ? (
                                                                <div className="flex flex-wrap gap-1">
                                                                    {grant.standing !== "live" ? (
                                                                        <Badge
                                                                            variant={
                                                                                STANDING_TONE[
                                                                                    grant.standing
                                                                                ]
                                                                            }
                                                                        >
                                                                            {t(
                                                                                `share.standings.${grant.standing}`
                                                                            )}
                                                                        </Badge>
                                                                    ) : null}
                                                                    {grant.password ? (
                                                                        <Badge variant="neutral">
                                                                            <Lock
                                                                                className="size-3 shrink-0"
                                                                                aria-hidden
                                                                            />
                                                                            {t("share.hasPassword")}
                                                                        </Badge>
                                                                    ) : null}
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                        {roleMenu(grant)}
                                                    </div>
                                                );
                                            })}
                                            {links.length === 0 && !draftAudience ? (
                                                <div className="flex min-w-0 items-start gap-3 px-1 py-1">
                                                    <span className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-foreground-subtle">
                                                        <Lock
                                                            className="size-4 shrink-0"
                                                            aria-hidden
                                                        />
                                                    </span>
                                                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                                                        {linkable ? (
                                                            <Select
                                                                aria-label={t("share.audienceOf")}
                                                                className="w-full sm:w-auto"
                                                                value="restricted"
                                                                onValueChange={(next) =>
                                                                    next !== "restricted" &&
                                                                    setDraftAudience(
                                                                        next as core.LinkAudience
                                                                    )
                                                                }
                                                                options={audiences.map(
                                                                    audienceOption
                                                                )}
                                                            />
                                                        ) : (
                                                            <p className="text-[13px] text-foreground">
                                                                {t(
                                                                    "share.audiences.restricted.label"
                                                                )}
                                                            </p>
                                                        )}
                                                        <p className="text-[12px] text-muted-foreground">
                                                            {linkable
                                                                ? t(
                                                                      "share.audiences.restricted.hint"
                                                                  )
                                                                : t("share.noLinks")}
                                                        </p>
                                                    </div>
                                                </div>
                                            ) : null}
                                            {linkable && links.length > 0 && !draftAudience ? (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="self-start"
                                                    onClick={() => setDraftAudience("anyone")}
                                                >
                                                    <Link2
                                                        className="size-4 shrink-0"
                                                        aria-hidden
                                                    />
                                                    {t("share.anotherLink")}
                                                </Button>
                                            ) : null}
                                            {draftAudience ? (
                                                <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3">
                                                    <Select
                                                        aria-label={t("share.audienceOf")}
                                                        value={draftAudience}
                                                        onValueChange={(next) =>
                                                            setDraftAudience(
                                                                next as core.LinkAudience
                                                            )
                                                        }
                                                        options={audiences.map(audienceOption)}
                                                    />
                                                    <p className="text-[12px] text-muted-foreground">
                                                        {t(
                                                            `share.audiences.${draftAudience}.hint`,
                                                            { org: setup?.org?.name ?? "" }
                                                        )}
                                                    </p>
                                                    <Select
                                                        aria-label={t("share.linkRole")}
                                                        value={linkCapability}
                                                        onValueChange={setLinkCapability}
                                                        options={linkCapabilities.map((one) => ({
                                                            value: one,
                                                            label: capabilityLabel(one)
                                                        }))}
                                                    />
                                                    {linkCapabilities.length <
                                                    capabilities.length ? (
                                                        <p className="text-[12px] text-foreground-subtle">
                                                            {t("share.linkSeeOnly")}
                                                        </p>
                                                    ) : null}
                                                    <LinkAdvancedFields
                                                        value={linkRules}
                                                        onChange={setLinkRules}
                                                        omit={
                                                            draftAudience === "restricted"
                                                                ? ["password"]
                                                                : []
                                                        }
                                                        idPrefix="share-link"
                                                    />
                                                    <div className="flex justify-end gap-2">
                                                        <Button
                                                            variant="ghost"
                                                            onClick={() => setDraftAudience(null)}
                                                        >
                                                            {t("share.cancel")}
                                                        </Button>
                                                        <Button
                                                            disabled={busy}
                                                            onClick={() => void makeLink()}
                                                        >
                                                            {busy ? (
                                                                <Loader2
                                                                    className="size-4 shrink-0 animate-spin"
                                                                    aria-hidden
                                                                />
                                                            ) : (
                                                                <Link2
                                                                    className="size-4 shrink-0"
                                                                    aria-hidden
                                                                />
                                                            )}
                                                            {t("share.makeLink")}
                                                        </Button>
                                                    </div>
                                                </div>
                                            ) : null}
                                            {madeLink ? (
                                                <div
                                                    role="status"
                                                    className="flex min-w-0 flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3"
                                                >
                                                    <p className="text-[12px] text-muted-foreground">
                                                        {t("share.linkMade")}
                                                    </p>
                                                    <div className="flex min-w-0 items-center gap-2">
                                                        <Input
                                                            readOnly
                                                            value={madeLink}
                                                            aria-label={t("share.linkName")}
                                                            onFocus={(event) =>
                                                                event.target.select()
                                                            }
                                                            className="min-w-0 flex-1"
                                                        />
                                                        <Button
                                                            size="icon"
                                                            variant="outline"
                                                            aria-label={t("share.copyLink")}
                                                            title={t("share.copyLink")}
                                                            onClick={() => void copy(madeLink)}
                                                        >
                                                            <Copy
                                                                className="size-4 shrink-0"
                                                                aria-hidden
                                                            />
                                                        </Button>
                                                    </div>
                                                </div>
                                            ) : null}
                                        </>
                                    )}
                                </section>
                                {extra}
                            </>
                        )}
                    </>
                )}

                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <Button
                            variant="outline"
                            disabled={!setup?.url}
                            title={t("share.copyHint")}
                            onClick={() => setup?.url && void copy(setup.url)}
                        >
                            <Link2 className="size-4 shrink-0" aria-hidden />
                            {t("share.copyLink")}
                        </Button>
                        {bounded && !history ? (
                            <Button variant="ghost" onClick={() => setHistory(true)}>
                                <History className="size-4 shrink-0" aria-hidden />
                                {t("share.history")}
                            </Button>
                        ) : null}
                    </div>
                    <Button onClick={() => onOpenChange(false)}>{t("share.done")}</Button>
                </div>
                {confirmDialog}
            </DialogContent>
        </Dialog>
    );
}

/** A face for somebody found or staged: a person's avatar, a group's icon. */
function TargetFace({ target, size }: { target: ShareTarget; size: number }) {
    if (target.type === "user") {
        return <Avatar person={{ id: target.id, name: target.name }} size={size} status={false} />;
    }
    const Icon = target.type === "team" ? Users : Shield;
    return (
        <span
            className="flex shrink-0 items-center justify-center rounded-full bg-surface-hover text-foreground-subtle"
            style={{ width: size, height: size }}
        >
            <Icon className="size-3.5 shrink-0" aria-hidden />
        </span>
    );
}

/** A row's face: the person's avatar (upload, then Gravatar, then initials) or
 *  the group's icon. */
function PrincipalFace({ grant }: { grant: GrantView }) {
    if (grant.principalType === "user") {
        return (
            <Avatar
                person={{ id: grant.principalId, name: grant.principalName }}
                size={32}
                status={false}
                lazy
            />
        );
    }
    const Icon = grant.principalType === "team" ? Users : Shield;
    return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-hover text-foreground-subtle">
            <Icon className="size-4 shrink-0" aria-hidden />
        </span>
    );
}

/**
 * The first row: whoever owns the thing, marked "Owner" and never editable. A
 * thing nobody owns (a door of the house) shows the person sharing instead.
 */
function OwnerRow({ setup }: { setup: ShareSetup }) {
    const t = useTranslations("components");
    const owner = setup.owner;
    const id = owner?.id ?? setup.viewer.id;
    const name = owner?.name ?? setup.viewer.name;
    const contact = owner ? owner.contact : setup.viewer.email;
    const isViewer = id === setup.viewer.id;
    return (
        <div className="flex min-w-0 items-center gap-3 px-1 py-1">
            <Avatar person={{ id, name }} size={32} status={false} />
            <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-foreground" title={name}>
                    {isViewer ? t("share.you", { name }) : name}
                </p>
                {contact ? (
                    <p className="truncate text-[12px] text-muted-foreground" title={contact}>
                        {contact}
                    </p>
                ) : null}
            </div>
            <span className="shrink-0 text-[12px] text-muted-foreground">
                {owner ? t("share.owner") : t("share.youCan")}
            </span>
        </div>
    );
}
