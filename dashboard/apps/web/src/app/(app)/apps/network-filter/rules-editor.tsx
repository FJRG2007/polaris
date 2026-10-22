"use client";

/**
 * The network filter's own rules as a list, like the Firewall's: each rule's
 * shape as a chip, its value and what it covers, its action, and edit and
 * delete beside it. Several can be added at once from a pasted list. Each
 * change is saved on its own, shown at once and put back if the save fails.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import {
    Fragment,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    shellScroller,
    Textarea
} from "@polaris/ui";
import { editDnsRuleAction } from "./actions";
import * as rules from "@/lib/dns-blocker/rules";
import * as dns from "@/lib/dns-blocker/settings";
import { useDnsBlocker } from "./dns-blocker-context";
import { useTranslations } from "@/components/i18n/i18n-provider";

type Rules = { allow: string[]; deny: string[] };
type Filter = "all" | rules.DnsRuleAction;
type Row = ReturnType<typeof rules.ruleRows>[number];

/** The dialog's state: adding, or editing the rule it was opened on. */
type Editing = { from: { action: rules.DnsRuleAction; rule: string } | null } | null;

/** What the dialog hands back: one rule, or several typed at once. */
type DialogResult =
    | { action: rules.DnsRuleAction; rule: string }
    | { action: rules.DnsRuleAction; rules: string[] };

/** The most entries of a paste drawn in the preview; the rest are counted. */
const PREVIEW_MAX = 60;

export function DnsRulesEditor() {
    const t = useTranslations("dnsBlocker");
    const { saved, adoptRules } = useDnsBlocker();
    const [pending, setPending] = useState<Rules | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [editing, setEditing] = useState<Editing>(null);

    const current: Rules = pending ?? { allow: saved.allow, deny: saved.deny };
    const rows = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return rules
            .ruleRows(current)
            .filter((row) => filter === "all" || row.action === filter)
            .filter((row) => !needle || row.rule.toLowerCase().includes(needle));
    }, [current, filter, search]);
    const total = current.allow.length + current.deny.length;

    /** Shown at once, saved, and put back when the save fails. */
    async function commit(edit: rules.DnsRuleEdit): Promise<string | null> {
        const next = rules.applyRuleEdit(current, edit);
        if (typeof next === "string") return t(`rules.refusal.${next}`);
        setPending(next);
        setError(null);
        const result = await editDnsRuleAction(edit);
        setPending(null);
        if (result.error !== undefined) {
            setError(result.error);
            return result.error;
        }
        adoptRules(result.settings);
        return null;
    }

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <CardTitle>{t("rules.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("rules.intro")}</p>
                </div>
                <Button size="sm" onClick={() => setEditing({ from: null })}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {t("rules.add")}
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                {total > 0 ? (
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <div className="relative min-w-0 flex-1">
                            <Search
                                className="pointer-events-none absolute left-2 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground"
                                aria-hidden
                            />
                            <Input
                                className="pl-8"
                                value={search}
                                placeholder={t("rules.search")}
                                aria-label={t("rules.search")}
                                onChange={(event) => setSearch(event.target.value)}
                            />
                        </div>
                        <Select
                            className="w-full sm:w-40"
                            value={filter}
                            aria-label={t("rules.filter")}
                            onValueChange={(value) => setFilter(value as Filter)}
                            options={[
                                { value: "all", label: t("rules.filterAll") },
                                { value: "allow", label: t("rules.action.allow") },
                                { value: "deny", label: t("rules.action.deny") }
                            ]}
                        />
                    </div>
                ) : null}
                {error ? (
                    <p role="alert" className="text-xs text-danger">
                        {error}
                    </p>
                ) : null}
                {total === 0 ? (
                    <EmptyState bare title={t("rules.empty")} description={t("rules.emptyHint")} />
                ) : rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("rules.noMatch")}</p>
                ) : (
                    <RuleList
                        rows={rows}
                        label={t("rules.title")}
                        renderRow={(row, ref, index) => (
                            <li
                                ref={ref}
                                data-index={index}
                                className="flex min-w-0 items-center gap-2 py-2"
                            >
                                <Badge variant="neutral" className="shrink-0">
                                    {t(`rules.kind.${row.kind}`)}
                                </Badge>
                                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                                    <code
                                        className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                                        title={row.rule}
                                    >
                                        {row.rule}
                                    </code>
                                    <RuleCoverage rule={row.rule} />
                                </span>
                                <span
                                    className={
                                        row.action === "allow"
                                            ? "shrink-0 text-xs font-medium text-success"
                                            : "shrink-0 text-xs font-medium text-danger"
                                    }
                                >
                                    {t(`rules.action.${row.action}`)}
                                </span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={t("rules.edit", { rule: row.rule })}
                                    title={t("rules.edit", { rule: row.rule })}
                                    onClick={() => setEditing({ from: row })}
                                >
                                    <Pencil className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={t("rules.remove", { rule: row.rule })}
                                    title={t("rules.remove", { rule: row.rule })}
                                    onClick={() =>
                                        void commit({
                                            op: "delete",
                                            from: { action: row.action, rule: row.rule }
                                        })
                                    }
                                >
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </Button>
                            </li>
                        )}
                    />
                )}
            </CardBody>
            {editing ? (
                <RuleDialog
                    from={editing.from}
                    existing={current}
                    onClose={() => setEditing(null)}
                    onSubmit={async (next) =>
                        commit(
                            "rules" in next
                                ? { op: "addMany", next }
                                : editing.from
                                  ? { op: "edit", from: editing.from, next }
                                  : { op: "add", next }
                        )
                    }
                />
            ) : null}
        </Card>
    );
}

/** What a rule reaches, in words, under any rule that is more than one name. */
function RuleCoverage({ rule }: { rule: string }) {
    const t = useTranslations("dnsBlocker");
    const { key, name } = rules.ruleCoverage(rule);
    if (key === "exact") return null;
    const text = t(`rules.covers.${key}`, { name });
    return (
        <span className="max-w-full truncate text-xs text-muted-foreground" title={text}>
            {text}
        </span>
    );
}

/** useLayoutEffect, without the warning a server render gives for it. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The rules, drawing only the ones on screen: windowed against the shell's
 *  content area, offset by where the list starts inside it, with the room of
 *  the rows not drawn kept above and below. */
function RuleList({
    rows,
    label,
    renderRow
}: {
    rows: readonly Row[];
    label: string;
    renderRow: (row: Row, ref: (node: Element | null) => void, index: number) => ReactNode;
}) {
    const list = useRef<HTMLUListElement>(null);
    const [margin, setMargin] = useState(0);

    useIsomorphicLayoutEffect(() => {
        const measure = () => {
            const element = list.current;
            const scroller = element ? shellScroller(element) : null;
            if (!element || !scroller) return;
            const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            setMargin(top + scroller.scrollTop);
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, []);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => (list.current ? shellScroller(list.current) : null),
        estimateSize: () => 45,
        overscan: 8,
        scrollMargin: margin,
        getItemKey: (index) => `${rows[index]!.action}:${rows[index]!.rule}`,
        initialRect: { width: 1280, height: 1000 }
    });
    const drawn = virtualizer.getVirtualItems();
    const last = drawn[drawn.length - 1];
    const above = drawn[0] ? drawn[0].start - margin : 0;
    const below = last ? virtualizer.getTotalSize() - (last.end - margin) : 0;

    return (
        <ul ref={list} className="flex flex-col divide-y divide-border" aria-label={label}>
            {above > 0 ? <li aria-hidden="true" style={{ height: above }} /> : null}
            {drawn.map((item) => (
                <Fragment key={item.key}>
                    {renderRow(rows[item.index]!, virtualizer.measureElement, item.index)}
                </Fragment>
            ))}
            {below > 0 ? <li aria-hidden="true" style={{ height: below }} /> : null}
        </ul>
    );
}

/** Adding rules or editing one, checked as it is typed against the schema the
 *  server checks it with. Adding takes several at once, separated by commas,
 *  spaces or line breaks, and shows what each one becomes before it is saved. */
export function RuleDialog({
    from,
    existing,
    onClose,
    onSubmit
}: {
    from: { action: rules.DnsRuleAction; rule: string } | null;
    existing: Rules;
    onClose: () => void;
    onSubmit: (next: DialogResult) => Promise<string | null>;
}) {
    const t = useTranslations("dnsBlocker");
    const [action, setAction] = useState<rules.DnsRuleAction>(from?.action ?? "deny");
    const [text, setText] = useState(from?.rule ?? "");
    const [refusal, setRefusal] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const parsed = rules.dnsRuleInputSchema.safeParse({ action, rule: text });
    const entries = useMemo(
        () => (from ? [] : rules.parseRuleEntries(text, existing[action])),
        [from, text, existing, action]
    );
    const adding = entries.flatMap((entry) => (entry.problem === null ? [entry.rule] : []));
    const left = entries.filter((entry) => entry.problem !== null);
    // An empty field is unfinished, not wrong.
    const incomplete = text.trim().length === 0;
    const invalid = from
        ? !incomplete && !parsed.success
        : entries.some((entry) => entry.problem === "invalidRule");
    const overLimit = !from && existing[action].length + adding.length > dns.DNS_LIMITS.rules;
    const ready = from ? parsed.success : adding.length > 0 && !overLimit;
    const only = !from && entries.length === 1 ? entries[0]! : null;

    async function submit() {
        if (!ready || busy) return;
        setBusy(true);
        let failure: string | null = null;
        if (from) failure = parsed.success ? await onSubmit(parsed.data) : null;
        else if (adding.length === 1) failure = await onSubmit({ action, rule: adding[0]! });
        else failure = await onSubmit({ action, rules: adding });
        setBusy(false);
        if (failure) setRefusal(failure);
        else onClose();
    }

    function change(value: string) {
        setText(value);
        setRefusal(null);
    }

    const shared = {
        value: text,
        autoFocus: true,
        spellCheck: false,
        className: "font-mono text-xs",
        placeholder: "ads.example.com",
        "aria-invalid": invalid
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{from ? t("rules.editTitle") : t("rules.addTitle")}</DialogTitle>
                    <DialogDescription>{t("rules.syntax")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex min-w-0 flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("rules.actionLabel")}</span>
                        <Select
                            value={action}
                            aria-label={t("rules.actionLabel")}
                            onValueChange={(value) => {
                                setAction(value as rules.DnsRuleAction);
                                setRefusal(null);
                            }}
                            options={[
                                { value: "deny", label: t("rules.action.deny") },
                                { value: "allow", label: t("rules.action.allow") }
                            ]}
                        />
                    </label>
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                        <span>
                            {from ? t("rules.value") : t("rules.valueMany")}{" "}
                            <span aria-hidden>*</span>
                        </span>
                        {from ? (
                            <Input {...shared} onChange={(event) => change(event.target.value)} />
                        ) : (
                            <Textarea
                                {...shared}
                                rows={3}
                                onChange={(event) => change(event.target.value)}
                                onKeyDown={(event) => {
                                    // Enter starts a line, as in any list; with
                                    // Ctrl or Cmd it adds the rules.
                                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                                        event.preventDefault();
                                        void submit();
                                    }
                                }}
                            />
                        )}
                        {from && invalid ? (
                            <span className="text-xs text-danger">
                                {t("validation.invalidRule")}
                            </span>
                        ) : null}
                        {from && parsed.success ? (
                            <span className="text-xs text-muted-foreground">
                                {t("rules.detected", {
                                    kind: t(`rules.kind.${rules.ruleKind(parsed.data.rule)}`)
                                })}
                            </span>
                        ) : null}
                        {only?.problem === null ? (
                            <span className="text-xs text-muted-foreground">
                                {t("rules.detected", {
                                    kind: t(`rules.kind.${rules.ruleKind(only.rule)}`)
                                })}
                            </span>
                        ) : null}
                        {only && only.problem !== null ? (
                            <span
                                className={
                                    only.problem === "invalidRule"
                                        ? "text-xs text-danger"
                                        : "text-xs text-muted-foreground"
                                }
                            >
                                {t(`rules.problem.${only.problem}`)}
                            </span>
                        ) : null}
                        {overLimit && !refusal ? (
                            <span role="alert" className="text-xs text-danger">
                                {t("rules.refusal.tooMany")}
                            </span>
                        ) : null}
                        {refusal ? (
                            <span role="alert" className="text-xs text-danger">
                                {refusal}
                            </span>
                        ) : null}
                    </label>
                    {!from && entries.length > 1 ? (
                        <RulePreview adding={adding} left={left} />
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("rules.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready || busy}>
                            {from
                                ? t("rules.saveRule")
                                : adding.length > 1
                                  ? t("rules.addMany", { count: adding.length })
                                  : t("rules.addRule")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** The rules a paste adds, as chips, and each entry left out with why. */
function RulePreview({
    adding,
    left
}: {
    adding: readonly string[];
    left: readonly rules.DnsRuleEntry[];
}) {
    const t = useTranslations("dnsBlocker");
    return (
        <div className="flex min-w-0 flex-col gap-2 text-xs">
            {adding.length > 0 ? (
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-muted-foreground">
                        {t("rules.preview", { count: adding.length })}
                    </span>
                    <ul
                        className="flex max-h-32 min-w-0 flex-wrap gap-1 overflow-y-auto"
                        aria-label={t("rules.preview", { count: adding.length })}
                    >
                        {adding.slice(0, PREVIEW_MAX).map((rule) => (
                            <li key={rule} className="min-w-0 max-w-full">
                                <Badge
                                    variant="neutral"
                                    className="max-w-full font-mono"
                                    title={`${rule} - ${t(`rules.kind.${rules.ruleKind(rule)}`)}`}
                                >
                                    <span className="truncate">{rule}</span>
                                </Badge>
                            </li>
                        ))}
                        {adding.length > PREVIEW_MAX ? (
                            <li className="text-muted-foreground">
                                {t("rules.more", { count: adding.length - PREVIEW_MAX })}
                            </li>
                        ) : null}
                    </ul>
                </div>
            ) : null}
            {left.length > 0 ? (
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-muted-foreground">
                        {t("rules.skipped", { count: left.length })}
                    </span>
                    <ul
                        className="flex max-h-32 min-w-0 flex-col gap-0.5 overflow-y-auto"
                        aria-label={t("rules.skipped", { count: left.length })}
                    >
                        {left.slice(0, PREVIEW_MAX).map((entry, index) => (
                            <li key={`${index}:${entry.text}`} className="flex min-w-0 gap-1.5">
                                <code
                                    className="min-w-0 max-w-[50%] shrink truncate font-mono"
                                    title={entry.text}
                                >
                                    {entry.text}
                                </code>
                                <span
                                    className={
                                        entry.problem === "invalidRule"
                                            ? "min-w-0 truncate text-danger"
                                            : "min-w-0 truncate text-muted-foreground"
                                    }
                                >
                                    {entry.problem ? t(`rules.problem.${entry.problem}`) : null}
                                </span>
                            </li>
                        ))}
                        {left.length > PREVIEW_MAX ? (
                            <li className="text-muted-foreground">
                                {t("rules.more", { count: left.length - PREVIEW_MAX })}
                            </li>
                        ) : null}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}
