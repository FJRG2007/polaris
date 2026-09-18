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
import { TpLinkMark } from "@/components/brand-icons";
import { useDisplayFormat } from "@/components/display-format";
import { IntegrationLogo } from "@/components/logos";
import { runAction } from "@/lib/run-action";

const ShareDialog = dynamic(
    () => import("@/components/access/share-dialog").then((module) => module.ShareDialog),
    { ssr: false }
);

const MediaPlayer = dynamic(
    () => import("@/components/media-player").then((module) => module.MediaPlayer),
    { ssr: false }
);

export const clientHost = {
    accessShareDialog: { ShareDialog },
    brandIcons: { TpLinkMark },
    displayFormat: { useDisplayFormat },
    logos: { IntegrationLogo },
    mediaPlayer: { MediaPlayer },
    runAction: { runAction }
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
