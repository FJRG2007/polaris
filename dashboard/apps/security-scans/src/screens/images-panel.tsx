"use client";

/**
 * Every image a server runs - Polaris's own, apps, agent sessions, the rest -
 * one row per image however many containers use it, with its newest scan's
 * counts and its findings a click away. Where the server cannot list its
 * containers, apps are scanned one by one as before.
 */

import { Package } from "lucide-react";
import * as actions from "../actions/security";
import type { SecurityTranslator } from "../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { FindingsTable, type ImageFinding } from "./findings-table";
import { Badge, Button, Card, CardBody, EmptyState, Skeleton } from "@polaris/ui";

type Images = Extract<Awaited<ReturnType<typeof actions.serverImagesAction>>, { ok: true }>["data"];
type Submit = (
    work: () => Promise<{ ok: boolean; error?: string }>,
    done?: string
) => Promise<void>;

const SOURCE_TONE: Record<string, "primary" | "neutral" | "warning"> = {
    polaris: "primary",
    app: "neutral",
    agent: "neutral",
    other: "warning"
};
const COUNTED = ["critical", "high", "medium", "low"] as const;

export function ImagesPanel({
    t,
    apps,
    targetId,
    submit
}: {
    t: SecurityTranslator;
    apps: readonly { id: string; name: string }[];
    targetId: string;
    submit: Submit;
}) {
    const [data, setData] = useState<Images | null>(null);
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState<string | null>(null);
    const [findings, setFindings] = useState<ImageFinding[] | null>(null);
    const [findingsFailed, setFindingsFailed] = useState(false);

    const load = useCallback(async () => {
        const result = await actions.serverImagesAction({ targetId });
        if (!result.ok) return setFailed(true);
        setFailed(false);
        setData(result.data);
    }, [targetId]);
    useEffect(() => {
        setData(null);
        void load();
    }, [load]);
    const busy = data?.images.some(
        (image) => image.scan?.state === "queued" || image.scan?.state === "running"
    );
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(() => void load(), 8000);
        return () => clearInterval(timer);
    }, [busy, load]);

    const readFindings = async (scanId: string) => {
        setFindings(null);
        setFindingsFailed(false);
        const result = await actions.findingsAction({ scanId });
        if (!result.ok) return setFindingsFailed(true);
        setFindings(result.data);
    };

    if (failed && !data) {
        return (
            <EmptyState
                icon={<Package />}
                title={t("loadFailed")}
                action={<Button onClick={() => void load()}>{t("tryAgain")}</Button>}
            />
        );
    }
    if (data && !data.available)
        return <AppsFallback t={t} apps={apps} targetId={targetId} submit={submit} />;

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">{t("images.allHint")}</p>
                {data && data.images.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("images.none")}</p>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="text-muted-foreground">
                            <tr>
                                <th
                                    scope="col"
                                    className="w-full max-w-0 px-2 py-1.5 text-left font-medium"
                                >
                                    {t("images.image")}
                                </th>
                                <th
                                    scope="col"
                                    className="hidden px-2 py-1.5 text-left font-medium lg:table-cell"
                                >
                                    {t("images.who")}
                                </th>
                                <th scope="col" className="px-2 py-1.5 text-left font-medium">
                                    {t("images.lastScan")}
                                </th>
                                <th scope="col" className="px-2 py-1.5">
                                    <span className="sr-only">{t("images.run")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {data === null
                                ? [0, 1, 2].map((row) => (
                                      <tr key={row} className="border-t border-border">
                                          <td className="w-full max-w-0 px-2 py-2">
                                              <Skeleton className="h-4 w-48 max-w-full" />
                                          </td>
                                          <td className="hidden px-2 py-2 lg:table-cell">
                                              <Skeleton className="h-5 w-16" />
                                          </td>
                                          <td className="px-2 py-2">
                                              <Skeleton className="h-5 w-24" />
                                          </td>
                                          <td className="px-2 py-2">
                                              <Skeleton className="h-6 w-16" />
                                          </td>
                                      </tr>
                                  ))
                                : data.images.map((image) => {
                                      const scan = image.scan;
                                      const counts = scan?.summary as
                                          | Record<string, unknown>
                                          | undefined;
                                      const expanded =
                                          open === image.imageId && scan?.state === "done";
                                      return [
                                          <tr
                                              key={image.imageId}
                                              className="border-t border-border align-top"
                                          >
                                              <td className="w-full max-w-0 px-2 py-1.5">
                                                  <span
                                                      className="block truncate font-medium"
                                                      title={`${image.ref}\n${image.imageId}`}
                                                  >
                                                      {image.ref}
                                                  </span>
                                                  <span
                                                      className="block truncate text-xs text-muted-foreground"
                                                      title={image.users.join(", ")}
                                                  >
                                                      <span className="lg:hidden">
                                                          {t(`images.source.${image.source}`)} -{" "}
                                                      </span>
                                                      {image.users.join(", ")}
                                                  </span>
                                              </td>
                                              <td className="hidden px-2 py-1.5 lg:table-cell">
                                                  <Badge
                                                      variant={
                                                          SOURCE_TONE[image.source] ?? "neutral"
                                                      }
                                                  >
                                                      {t(`images.source.${image.source}`)}
                                                  </Badge>
                                              </td>
                                              <td className="px-2 py-1.5">
                                                  {!scan ? (
                                                      <span className="text-muted-foreground">
                                                          {t("images.notScanned")}
                                                      </span>
                                                  ) : scan.state !== "done" ? (
                                                      <span className="text-muted-foreground">
                                                          {scan.state === "failed" && scan.error
                                                              ? t(`errors.${scan.error}` as never)
                                                              : t(`state.${scan.state}` as never)}
                                                      </span>
                                                  ) : (
                                                      <span className="flex flex-wrap gap-1">
                                                          {COUNTED.filter(
                                                              (sev) =>
                                                                  Number(counts?.[sev] ?? 0) > 0
                                                          ).map((sev) => (
                                                              <Badge
                                                                  key={sev}
                                                                  variant={
                                                                      sev === "medium"
                                                                          ? "warning"
                                                                          : sev === "low"
                                                                            ? "neutral"
                                                                            : "danger"
                                                                  }
                                                              >
                                                                  {t(`images.severity.${sev}`)}{" "}
                                                                  {Number(counts?.[sev])}
                                                              </Badge>
                                                          ))}
                                                          {COUNTED.every(
                                                              (sev) =>
                                                                  Number(counts?.[sev] ?? 0) === 0
                                                          ) ? (
                                                              <Badge variant="success">
                                                                  {t("images.clean")}
                                                              </Badge>
                                                          ) : null}
                                                      </span>
                                                  )}
                                              </td>
                                              <td className="whitespace-nowrap px-2 py-1.5 text-right">
                                                  {scan?.state === "done" ? (
                                                      <Button
                                                          size="xs"
                                                          variant="ghost"
                                                          aria-expanded={expanded}
                                                          onClick={() => {
                                                              if (expanded) return setOpen(null);
                                                              setOpen(image.imageId);
                                                              void readFindings(scan.id);
                                                          }}
                                                      >
                                                          {expanded ? t("hide") : t("details")}
                                                      </Button>
                                                  ) : null}
                                                  <Button
                                                      size="xs"
                                                      variant="outline"
                                                      disabled={
                                                          scan?.state === "queued" ||
                                                          scan?.state === "running"
                                                      }
                                                      onClick={() =>
                                                          void submit(
                                                              () =>
                                                                  actions.scanServerImageAction({
                                                                      targetId,
                                                                      imageId: image.imageId
                                                                  }),
                                                              t("queued")
                                                          ).then(load)
                                                      }
                                                  >
                                                      {t("images.run")}
                                                  </Button>
                                              </td>
                                          </tr>,
                                          expanded && scan ? (
                                              <tr key={`${image.imageId}-findings`}>
                                                  <td colSpan={4} className="px-2 pb-3">
                                                      <FindingsTable
                                                          t={t}
                                                          findings={findings}
                                                          failed={findingsFailed}
                                                          onRetry={() => void readFindings(scan.id)}
                                                      />
                                                  </td>
                                              </tr>
                                          ) : null
                                      ];
                                  })}
                        </tbody>
                    </table>
                )}
            </CardBody>
        </Card>
    );
}

/** No container listing on this server: scan each app's running image. */
function AppsFallback({
    t,
    apps,
    targetId,
    submit
}: {
    t: SecurityTranslator;
    apps: readonly { id: string; name: string }[];
    targetId: string;
    submit: Submit;
}) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">{t("images.hint")}</p>
                <p className="text-sm text-muted-foreground">{t("images.listUnavailable")}</p>
                {apps.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("images.noApps")}</p>
                ) : null}
                <ul className="flex flex-col gap-1">
                    {apps.map((app) => (
                        <li key={app.id} className="flex min-w-0 items-center gap-2 text-sm">
                            <span className="min-w-0 flex-1 truncate" title={app.name}>
                                {app.name}
                            </span>
                            <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                    void submit(
                                        () =>
                                            actions.scanImageAction({
                                                targetId,
                                                applicationId: app.id
                                            }),
                                        t("queued")
                                    )
                                }
                            >
                                {t("images.run")}
                            </Button>
                        </li>
                    ))}
                </ul>
            </CardBody>
        </Card>
    );
}
