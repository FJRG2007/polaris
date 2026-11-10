"use client";

/**
 * Every website this account can open, as a table: what it is, where it answers,
 * who came in the last day, and whether its tag counts. Searched and loaded a
 * page at a time. A row opens the site; its menu edits, copies the tag, shares or
 * removes it, each offered only to somebody the server would let do it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Globe, MoreHorizontal, Pencil, Plus, Server, Settings, Share2, ShieldCheck, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    Skeleton
} from "@polaris/ui";
import * as polls from "../analytics-polls";
import { useAppUrl } from "@/components/app-url";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import type { SiteTableRow } from "@/lib/analytics-lists";
import { ShareDialog } from "@/components/access/share-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { bareHost, externalSiteSchema, trackerSnippet } from "../site-input";
import { deleteExternalSiteAction, updateExternalSiteAction } from "../actions";

/** Last first page per search, drawn at once on the way back and refreshed behind. */
const firstPages = new Map<string, { rows: SiteTableRow[]; next: string | null }>();

function siteHref(site: SiteTableRow, path = "/analytics"): string {
    return site.scope === "polaris"
        ? `${path}?scope=polaris`
        : `${path}?scope=${site.scope}&id=${encodeURIComponent(site.id)}`;
}

const KIND_ICON = { polaris: ShieldCheck, external: Globe, application: Server } as const;

export function SitesView({ canAdd }: { canAdd: boolean }) {
    const t = useTranslations("analytics");
    const router = useRouter();
    const baseUrl = useAppUrl();
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState("");
    const cached = firstPages.get(search);
    const [rows, setRows] = useState<SiteTableRow[] | null>(cached?.rows ?? null);
    const [next, setNext] = useState<string | null>(cached?.next ?? null);
    const [loading, setLoading] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [editing, setEditing] = useState<SiteTableRow | null>(null);
    const [sharing, setSharing] = useState<SiteTableRow | null>(null);
    const [confirm, confirmElement] = useConfirm();
    const inflight = useRef<AbortController | null>(null);

    // Typing settles before it asks.
    useEffect(() => {
        const timer = setTimeout(() => setSearch(query.trim()), 250);
        return () => clearTimeout(timer);
    }, [query]);

    const fetchPage = useCallback(
        (cursor: string | null) => {
            inflight.current?.abort();
            const controller = new AbortController();
            inflight.current = controller;
            setLoading(true);
            polls
                .analyticsSiteList({ ...(cursor ? { cursor } : {}), ...(search ? { query: search } : {}) }, controller.signal)
                .then((result) => {
                    if (controller.signal.aborted) return;
                    if ("error" in result) {
                        setFailure(result.error);
                        setRows((current) => current ?? []);
                        return;
                    }
                    setFailure(null);
                    setNext(result.next);
                    if (cursor) setRows((current) => [...(current ?? []), ...result.rows]);
                    else {
                        firstPages.set(search, result);
                        setRows(result.rows);
                    }
                })
                .catch(() => {
                    if (controller.signal.aborted) return;
                    setFailure(t("sites.loadFailed"));
                    setRows((current) => current ?? []);
                })
                .finally(() => {
                    if (!controller.signal.aborted) setLoading(false);
                });
        },
        [search, t]
    );

    useEffect(() => {
        const hit = firstPages.get(search);
        setRows(hit?.rows ?? null);
        setNext(hit?.next ?? null);
        fetchPage(null);
        return () => inflight.current?.abort();
    }, [search, fetchPage]);

    async function remove(site: SiteTableRow) {
        const sure = await confirm({
            title: t("sites.removeTitle", { name: site.label }),
            description: t("sites.removeBody"),
            confirmLabel: t("sites.remove"),
            danger: true
        });
        if (!sure) return;
        const previous = rows;
        setRows((current) => (current ?? []).filter((one) => one.id !== site.id));
        const result = await deleteExternalSiteAction({ scopeType: "external", scopeId: site.id });
        if (result.error) {
            setFailure(result.error);
            setRows(previous);
        } else firstPages.clear();
    }

    function copyTag(site: SiteTableRow) {
        if (!site.publicKey) return;
        void navigator.clipboard.writeText(trackerSnippet("html", baseUrl, site.publicKey)).catch(() => {
            setFailure(t("sites.copyFailed"));
        });
    }

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="min-w-0 flex-1 truncate text-[1.0625rem] font-semibold tracking-tight">
                    {t("sections.sites")}
                </h1>
                {canAdd ? (
                    <Button asChild size="sm">
                        <Link href="/analytics/sites/new">
                            <Plus aria-hidden="true" />
                            {t("sites.add")}
                        </Link>
                    </Button>
                ) : null}
            </div>
            <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("sites.search")}
                aria-label={t("sites.search")}
                maxLength={120}
                className="w-full sm:max-w-sm"
            />
            {failure ? (
                <p role="alert" className="rounded-md border border-danger-edge bg-danger-soft px-4 py-3 text-sm text-danger-ink">
                    {failure}
                </p>
            ) : null}
            <Card className="min-w-0">
                <CardBody className="p-0">
                    <div className="min-w-0 overflow-x-auto">
                        <table className="w-full min-w-[40rem] table-fixed text-sm">
                            <thead>
                                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                                    <th className="w-[34%] px-4 py-2 font-medium">{t("sites.colName")}</th>
                                    <th className="w-[26%] px-3 py-2 font-medium">{t("sites.colAddress")}</th>
                                    <th className="w-[12%] px-3 py-2 text-right font-medium">{t("sites.colVisitors")}</th>
                                    <th className="w-[12%] px-3 py-2 font-medium">{t("sites.colTag")}</th>
                                    <th className="hidden w-[12%] px-3 py-2 font-medium lg:table-cell">{t("sites.colCreated")}</th>
                                    <th className="w-12 px-2 py-2">
                                        <span className="sr-only">{t("sites.colActions")}</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows === null
                                    ? Array.from({ length: 6 }, (_, index) => (
                                          <tr key={index} className="border-b border-border last:border-0">
                                              <td colSpan={6} className="px-4 py-2">
                                                  <Skeleton className="h-8 w-full" />
                                              </td>
                                          </tr>
                                      ))
                                    : rows.map((site) => {
                                          const Icon = KIND_ICON[site.scope];
                                          const address = site.hostnames.join(", ");
                                          return (
                                              <tr
                                                  key={`${site.scope}:${site.id}`}
                                                  className="border-b border-border last:border-0 hover:bg-muted/40"
                                              >
                                                  <td className="px-4 py-2">
                                                      <Link href={siteHref(site)} className="flex min-w-0 items-center gap-2">
                                                          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                                          <span className="min-w-0 flex-1 truncate font-medium" title={site.label}>
                                                              {site.label}
                                                          </span>
                                                          <Badge variant="neutral" className="hidden shrink-0 sm:inline-flex">
                                                              {t(`scopes.${site.scope}`)}
                                                          </Badge>
                                                      </Link>
                                                  </td>
                                                  <td className="px-3 py-2">
                                                      <span className="block min-w-0 truncate text-muted-foreground" title={address || undefined}>
                                                          {address || t("sites.noAddress")}
                                                      </span>
                                                  </td>
                                                  <td className="px-3 py-2 text-right tabular-nums">{site.visitors}</td>
                                                  <td className="px-3 py-2">
                                                      <Badge variant={site.trackerEnabled ? "success" : "neutral"}>
                                                          {site.trackerEnabled ? t("sites.tagOn") : t("sites.tagOff")}
                                                      </Badge>
                                                  </td>
                                                  <td className="hidden truncate px-3 py-2 text-muted-foreground lg:table-cell">
                                                      {site.createdAt ? <RelativeTime iso={site.createdAt} /> : "-"}
                                                  </td>
                                                  <td className="px-2 py-2 text-right">
                                                      <DropdownMenu>
                                                          <DropdownMenuTrigger asChild>
                                                              <Button
                                                                  size="icon"
                                                                  variant="ghost"
                                                                  aria-label={t("sites.actionsFor", { name: site.label })}
                                                              >
                                                                  <MoreHorizontal className="size-4" />
                                                              </Button>
                                                          </DropdownMenuTrigger>
                                                          <DropdownMenuContent align="end" className="min-w-[12rem]">
                                                              <DropdownMenuItem onSelect={() => router.push(siteHref(site))}>
                                                                  <Globe className="size-3.5" />
                                                                  {t("sites.open")}
                                                              </DropdownMenuItem>
                                                              <DropdownMenuItem onSelect={() => router.push(siteHref(site, "/analytics/settings"))}>
                                                                  <Settings className="size-3.5" />
                                                                  {t("sections.site")}
                                                              </DropdownMenuItem>
                                                              <DropdownMenuItem disabled={!site.publicKey} onSelect={() => copyTag(site)}>
                                                                  <Copy className="size-3.5" />
                                                                  {site.publicKey ? t("sites.copyTag") : t("sites.copyTagLater")}
                                                              </DropdownMenuItem>
                                                              {site.canShare ? (
                                                                  <DropdownMenuItem onSelect={() => setSharing(site)}>
                                                                      <Share2 className="size-3.5" />
                                                                      {t("sites.share")}
                                                                  </DropdownMenuItem>
                                                              ) : null}
                                                              {site.canEdit ? (
                                                                  <>
                                                                      <DropdownMenuItem onSelect={() => setEditing(site)}>
                                                                          <Pencil className="size-3.5" />
                                                                          {t("sites.edit")}
                                                                      </DropdownMenuItem>
                                                                      <DropdownMenuSeparator />
                                                                      <DropdownMenuItem variant="danger" onSelect={() => void remove(site)}>
                                                                          <Trash2 className="size-3.5" />
                                                                          {t("sites.remove")}
                                                                      </DropdownMenuItem>
                                                                  </>
                                                              ) : null}
                                                          </DropdownMenuContent>
                                                      </DropdownMenu>
                                                  </td>
                                              </tr>
                                          );
                                      })}
                            </tbody>
                        </table>
                    </div>
                    {rows !== null && rows.length === 0 ? (
                        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-muted-foreground">
                            <span>{search ? t("sites.noMatch") : t("sites.none")}</span>
                            {canAdd && !search ? (
                                <Button asChild size="sm" variant="outline">
                                    <Link href="/analytics/sites/new">{t("sites.add")}</Link>
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                    {next && rows && rows.length > 0 ? (
                        <div className="flex justify-center border-t border-border p-2">
                            <Button size="sm" variant="ghost" disabled={loading} onClick={() => fetchPage(next)}>
                                {t("sites.more")}
                            </Button>
                        </div>
                    ) : null}
                </CardBody>
            </Card>
            {editing ? (
                <EditSiteDialog
                    site={editing}
                    onClose={() => setEditing(null)}
                    onSaved={(name, hostname) => {
                        firstPages.clear();
                        setRows((current) =>
                            (current ?? []).map((one) =>
                                one.id === editing.id && one.scope === "external"
                                    ? { ...one, label: name, hostnames: hostname ? [hostname] : [] }
                                    : one
                            )
                        );
                        setEditing(null);
                    }}
                />
            ) : null}
            {sharing ? (
                <ShareDialog
                    open
                    onOpenChange={(open) => {
                        if (!open) setSharing(null);
                    }}
                    subject="analytics.site"
                    subjectId={sharing.grantId ?? ""}
                    name={sharing.label}
                />
            ) : null}
            {confirmElement}
        </div>
    );
}

/** Rename an external site or move it to another address. */
function EditSiteDialog({
    site,
    onClose,
    onSaved
}: {
    site: SiteTableRow;
    onClose: () => void;
    onSaved: (name: string, hostname: string) => void;
}) {
    const t = useTranslations("analytics");
    const [name, setName] = useState(site.label);
    const [hostname, setHostname] = useState(site.hostnames[0] ?? "");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const value = { name: name.trim(), hostname: bareHost(hostname) };
    const parsed = externalSiteSchema.safeParse(value);
    const unchanged = value.name === site.label && value.hostname === (site.hostnames[0] ?? "");

    async function save() {
        if (!parsed.success || unchanged) return;
        setSaving(true);
        setError(null);
        const result = await updateExternalSiteAction({ scopeType: "external", scopeId: site.id, site: parsed.data });
        setSaving(false);
        if (result.error) setError(result.error);
        else onSaved(parsed.data.name, parsed.data.hostname);
    }

    return (
        <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("sites.editTitle")}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("add.name")} *</span>
                        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("add.hostname")}</span>
                        <Input
                            value={hostname}
                            onChange={(event) => setHostname(event.target.value)}
                            maxLength={253}
                            aria-invalid={!parsed.success && value.name !== ""}
                        />
                    </label>
                    {!parsed.success && value.name !== "" ? (
                        <p className="text-xs text-danger">{t("errors.siteInput")}</p>
                    ) : null}
                    {error ? <p className="text-xs text-danger">{error}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("sites.cancel")}
                        </Button>
                        <Button type="submit" disabled={!parsed.success || unchanged || saving}>
                            {t("sites.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
