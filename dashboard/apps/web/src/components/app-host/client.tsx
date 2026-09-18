"use client";

/**
 * What the dashboard offers installable apps in the browser: the shared
 * components, hooks and helpers of its shell. The client half of
 * `lib/app-host/server.ts`, and a contract in the same way.
 *
 * Provided when this module is evaluated, which the dashboard's layout
 * guarantees by rendering `ProvideAppHostUi` above every app's screens - so
 * this module is in the chunk every authenticated page loads, and what it
 * imports is paid for by screens that never draw any of it. A piece that
 * carries a graph of its own is therefore loaded when it is first drawn
 * rather than imported here; the small ones, drawn on most screens, are not
 * worth a chunk of their own.
 */

import dynamic from "next/dynamic";
import { provideAppHostUi } from "@polaris/app-host/client";
import {
    canOpenGameTab,
    gameTabHref,
    gameTabLabel,
    isGameTab,
    visibleGameTabs
} from "@/app/(app)/apps/installed/[id]/tabs";
import { runAction } from "@/lib/run-action";
import { GameLogo } from "@/components/game-logo";
import { relativeTime } from "@/lib/relative-time";
import { IntegrationLogo } from "@/components/logos";
import { TpLinkMark } from "@/components/brand-icons";
import { CopyButton } from "@/components/copy-button";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { ToolbarSwitch } from "@/components/toolbar-switch";
import { useSessionScope } from "@/components/session-scope";
import { useDisplayFormat } from "@/components/display-format";
import { useRuntimeLog } from "@/app/(app)/apps/installed/[id]/use-runtime-log";
import { CONSUMPTION_METRICS, PLAYER_METRICS } from "@/components/metrics-specs";
import { dropSnapshots, readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";

const ShareDialog = dynamic(
    () => import("@/components/access/share-dialog").then((module) => module.ShareDialog),
    { ssr: false }
);

const MediaPlayer = dynamic(
    () => import("@/components/media-player").then((module) => module.MediaPlayer),
    { ssr: false }
);

/** Its module reaches the mention server actions, which nothing that merely
 *  renders a screen should pay for. */
const AccountInput = dynamic(
    () => import("@/components/account-input").then((module) => module.AccountInput),
    { ssr: false }
);

/** A chart library and a log parser: drawn on a game server's own tabs and
 *  nowhere else an app reaches, so loaded there. The specs a screen hands the
 *  chart are in `metrics-specs`, which is light. Typed as what it wraps, because
 *  `dynamic` would otherwise erase the chart's generic point type. */
const MetricsHistory = dynamic(
    () => import("@/components/metrics-history").then((module) => module.MetricsHistory),
    { ssr: false }
) as typeof import("@/components/metrics-history").MetricsHistory;

const LogViewer = dynamic(
    () => import("@/components/log-viewer").then((module) => module.LogViewer),
    { ssr: false }
);

/** Server actions, loaded when first called rather than bundled with every page. */
type AccessActions = typeof import("@/app/(app)/apps/installed/[id]/access-actions");
const accessActions = () => import("@/app/(app)/apps/installed/[id]/access-actions");
const installAccessAction = (...args: Parameters<AccessActions["installAccessAction"]>) =>
    accessActions().then((module) => module.installAccessAction(...args));
const revokeInstallAccessAction = (
    ...args: Parameters<AccessActions["revokeInstallAccessAction"]>
) => accessActions().then((module) => module.revokeInstallAccessAction(...args));
const shareInstallAction = (...args: Parameters<AccessActions["shareInstallAction"]>) =>
    accessActions().then((module) => module.shareInstallAction(...args));

export const clientHost = {
    accessShareDialog: { ShareDialog },
    accountInput: { AccountInput },
    appAppsInstalledIdAccessActions: {
        installAccessAction,
        revokeInstallAccessAction,
        shareInstallAction
    },
    appAppsInstalledIdTabs: {
        canOpenGameTab,
        gameTabHref,
        gameTabLabel,
        isGameTab,
        visibleGameTabs
    },
    appAppsInstalledIdUseRuntimeLog: { useRuntimeLog },
    brandIcons: { TpLinkMark },
    confirmDialog: { useConfirm },
    copyButton: { CopyButton },
    displayFormat: { useDisplayFormat },
    gameLogo: { GameLogo },
    logViewer: { LogViewer },
    logos: { IntegrationLogo },
    mediaPlayer: { MediaPlayer },
    metricsHistory: { CONSUMPTION_METRICS, MetricsHistory, PLAYER_METRICS },
    relativeTime: { RelativeTime, relativeTime },
    runAction: { runAction },
    sessionScope: { useSessionScope },
    sharedStream: { subscribeSharedStream },
    snapshotCache: { dropSnapshots, readSnapshot, writeSnapshot },
    toolbarSwitch: { ToolbarSwitch }
};

type ClientHost = typeof clientHost;

declare module "@polaris/app-host/client" {
    interface AppHostUi extends ClientHost {}
}

provideAppHostUi(clientHost);

/** Rendered by the layout so this module is loaded before any app's screen. */
export function ProvideAppHostUi(): null {
    return null;
}
