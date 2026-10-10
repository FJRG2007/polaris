/**
 * A modded server's "Incompatible client!" explained: somebody joined with mods
 * this server does not have, or without one it needs on the client.
 */

import { describe, expect, it } from "vitest";
import { incompatibleClients } from "@polaris-app/game-servers/src/lib/minecraft/join-refusals";

describe("players turned away for their mods", () => {
    it("finds the refusals and who they were, where the line names them", () => {
        const log = [
            "[12:00:01] [Server thread/INFO] [minecraft/MinecraftServer]: Done (4.2s)!",
            "[12:01:10] [Server thread/INFO] [minecraft/ServerCommonPacketListenerImpl]: Alex lost connection: Incompatible client! Please use NeoForge",
            "[12:02:30] [Netty Server IO #3/INFO]: Disconnecting GameProfile{id=123, name=Steve}: Incompatible client!",
            "[12:03:00] [Server thread/INFO]: Alex (/10.0.0.2:51234) lost connection: Incompatible client!"
        ].join("\n");
        expect(incompatibleClients(log)).toEqual({ count: 3, players: ["Alex", "Steve"] });
    });

    it("still reports a refusal whose line names nobody", () => {
        expect(incompatibleClients("[INFO]: Incompatible client!")).toEqual({
            count: 1,
            players: []
        });
    });

    it("is null for a log with none", () => {
        expect(incompatibleClients("")).toBeNull();
        expect(incompatibleClients("Alex lost connection: Disconnected")).toBeNull();
    });
});
