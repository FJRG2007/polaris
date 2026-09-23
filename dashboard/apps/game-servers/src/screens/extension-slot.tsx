"use client";

/**
 * What Game servers draws inside core screens, by slot kind.
 *
 * The server half (`lib/apps/games-extension.ts`) decides which slot a screen
 * gets and reads what it needs; this draws it.
 */

import Link from "next/link";
import { Button, Card, CardBody } from "@polaris/ui";
import { ArkPanel } from "./installed/ark-panel";
import { FivemPanel } from "./installed/fivem-panel";
import { HytalePanel } from "./installed/hytale-panel";
import type { GameContext } from "./installed/game-context";
import { MinecraftPanel } from "./installed/minecraft-panel";
import { GamesFirewallSection, type GamesFirewallSectionProps } from "./firewall-section";
import type { AppHostTypes } from "@polaris/app-host";

type AppSlot = AppHostTypes["AppSlot"];
type InstalledSlotHost = AppHostTypes["InstalledSlotHost"];

export function GameServersSlot({ slot, host }: { slot: AppSlot; host?: InstalledSlotHost }) {
    switch (slot.kind) {
        case "firewall":
            return <GamesFirewallSection {...(slot.props as GamesFirewallSectionProps)} />;
        case "app-home":
            return <GameServersHome />;
        case "server":
            return host ? (
                <ServerPanel
                    host={host}
                    context={(slot.props as { context: GameContext | null }).context}
                />
            ) : null;
        default:
            return null;
    }
}

/**
 * The Game servers app's own install page. It runs nothing itself - its
 * dashboard is the Game servers page - so this is the door to it rather than a
 * second copy of the list. The per-game ids it replaced land here too, until
 * their owner opens either page and they are adopted.
 */
function GameServersHome() {
    return (
        <Card>
            <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm font-medium">Your servers live on the Game servers page</p>
                <p className="max-w-md text-sm text-muted-foreground">
                    Create as many as you want, of any game Polaris knows, each with its own
                    address, console, players and settings. The app itself runs nothing.
                </p>
                <Link href="/apps/games">
                    <Button size="sm">Open Game servers</Button>
                </Link>
            </CardBody>
        </Card>
    );
}

function ServerPanel({ host, context }: { host: InstalledSlotHost; context: GameContext | null }) {
    const { app, settings, running, held, onStatus } = host;
    switch (app.catalogId) {
        case "hytale":
            return (
                <HytalePanel
                    installedAppId={app.id}
                    applicationId={app.applicationId}
                    running={running}
                />
            );
        case "fivem":
            return (
                <FivemPanel
                    installedAppId={app.id}
                    applicationId={app.applicationId}
                    running={running}
                    game={context}
                    held={held}
                    onStatus={onStatus}
                />
            );
        case "ark":
            return (
                <ArkPanel
                    installedAppId={app.id}
                    applicationId={app.applicationId}
                    settings={settings}
                    running={running}
                    game={context}
                    held={held}
                    onStatus={onStatus}
                />
            );
        // Both editions are driven by the same panel; what differs is underneath,
        // and the panel offers what the edition it is looking at actually has.
        case "minecraft":
        case "minecraft-bedrock":
            return (
                <MinecraftPanel
                    installedAppId={app.id}
                    applicationId={app.applicationId}
                    name={app.name}
                    settings={settings}
                    running={running}
                    game={context}
                    held={held}
                    onStatus={onStatus}
                />
            );
        default:
            return null;
    }
}
