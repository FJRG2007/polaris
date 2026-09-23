/**
 * Reading which plugins a server refused to load.
 *
 * The log below is the real one, captured while building the Skyblock blueprint
 * on Docker: the jar arrives, the server refuses it, and then starts perfectly
 * happily without it. That is the quietest failure a server has - everything on
 * screen says the plugin is installed, and the thing it was installed for is
 * simply not in the game.
 */

import { describe, expect, it } from "vitest";
import {
    pluginName,
    refusedPlugins
} from "@polaris-app/game-servers/src/lib/minecraft/plugin-load";

/** Trimmed from the real boot, frames and all. */
const SKYBLOCK = `
[17:50:05 INFO]: Starting minecraft server version 26.2
[17:50:06 ERROR]: [ModernPluginLoadingStrategy] Could not load 'plugins/IridiumSkyblock-4.1.5.jar' in 'plugins'
org.bukkit.plugin.UnknownDependencyException: Unknown/missing dependency plugins: [Vault]. Please download and install these plugins to run 'IridiumSkyblock'.
\tat io.papermc.paper.plugin.entrypoint.strategy.modern.ModernPluginLoadingStrategy.loadProviders(ModernPluginLoadingStrategy.java:82) ~[paper-26.2.jar:26.2-128-5749698]
\tat org.bukkit.craftbukkit.CraftServer.loadPlugins(CraftServer.java:549) ~[paper-26.2.jar:26.2-128-5749698]
[17:50:06 WARN]: **** SERVER IS RUNNING IN OFFLINE/INSECURE MODE!
[17:50:06 INFO]: Preparing level "world"
[17:50:08 INFO]: Done (2.104s)! For help, type "help"
`;

describe("what the server would not load", () => {
    it("names the plugin rather than the jar file", () => {
        const [refused] = refusedPlugins(SKYBLOCK);
        expect(refused?.jar).toBe("IridiumSkyblock-4.1.5.jar");
        expect(refused?.name).toBe("IridiumSkyblock");
    });

    it("says why in the server's own words, without the package name", () => {
        const [refused] = refusedPlugins(SKYBLOCK);
        expect(refused?.why).toBe(
            "Unknown/missing dependency plugins: [Vault]. Please download and install these plugins to run 'IridiumSkyblock'."
        );
    });

    it("picks out the plugin that is missing, which is the part Polaris can fix", () => {
        expect(refusedPlugins(SKYBLOCK)[0]?.needs).toEqual(["Vault"]);
    });

    it("never reports a stack frame as the reason", () => {
        for (const refused of refusedPlugins(SKYBLOCK)) expect(refused.why).not.toContain(" at ");
    });

    it("says nothing about a server where everything loaded", () => {
        expect(
            refusedPlugins(`
[17:50:54 INFO]: Starting minecraft server version 1.21.4
[17:50:57 INFO]: [IP] Enabling IP v5.3.1
[17:50:58 INFO]: Done (3.1s)! For help, type "help"
`)
        ).toEqual([]);
    });

    it("forgets a refusal from before the last restart", () => {
        // A log long enough to hold two boots would otherwise report a plugin
        // that loads perfectly well now, which is worse than saying nothing.
        const fixed = `${SKYBLOCK}
[18:02:11 INFO]: Starting minecraft server version 26.2
[18:02:14 INFO]: [Vault] Enabling Vault v1.7.3-b131
[18:02:15 INFO]: [IridiumSkyblock] Enabling IridiumSkyblock v4.1.5
[18:02:16 INFO]: Done (4.2s)! For help, type "help"
`;
        expect(refusedPlugins(fixed)).toEqual([]);
    });

    it("reads a jar whose name has no version on it", () => {
        expect(pluginName("Vault.jar")).toBe("Vault");
        expect(pluginName("bedwars-plugin-25.3-SNAPSHOT.jar")).toBe("bedwars-plugin");
        expect(pluginName("IridiumSkyblock-4.1.5.jar")).toBe("IridiumSkyblock");
    });
});
