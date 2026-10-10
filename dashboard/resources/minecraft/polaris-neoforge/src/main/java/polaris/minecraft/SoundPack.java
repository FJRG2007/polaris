package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.common.ClientboundResourcePackPopPacket;
import net.minecraft.network.protocol.common.ClientboundResourcePackPushPacket;
import net.minecraft.network.protocol.common.ServerboundResourcePackPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;
import net.minecraft.server.network.config.ServerResourcePackConfigurationTask;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.network.event.RegisterConfigurationTasksEvent;
import net.neoforged.neoforge.server.ServerLifecycleHooks;

/**
 * The server's own sounds, handed to its players live.
 *
 * Polaris builds a resource pack from the sounds uploaded on the server's Sounds
 * tab; this asks for it when the server starts and whenever the dashboard says
 * it changed ({@code polaris sounds refresh}), and pushes it to everybody on and
 * everybody who joins - under an id of its own, so it stacks on top of the
 * server's own pack instead of replacing it, and a new one replaces the last.
 *
 * A joining player is handed it while their game is still connecting (the
 * configuration phase, as the server's own pack is), so the reload it costs
 * happens behind the joining screen instead of on a second screen once they are
 * in the world. One who joined before Polaris answered gets it on arrival.
 *
 * A player whose game has loaded it carries the {@link SoundConfig#LOADED_TAG}
 * tag, which is what the dashboard's commands play the server's sounds to; the
 * rest hear the game's own. Their answers come from {@code
 * ResourcePackResponseMixin}. A player who turns down a pack the server requires
 * is disconnected.
 */
final class SoundPack {
    private static final long RETRY_SECONDS = 60;
    private static volatile SoundPack instance;

    private final PolarisClient client;
    private final String path;
    private volatile SoundConfig config = SoundConfig.NONE;
    /** Each online player's answer to the pack pushed last. */
    private final Map<UUID, String> states = new ConcurrentHashMap<>();
    /** Players on their first visit, owed the welcome once their pack loads. */
    private final Set<UUID> welcomeOwed = ConcurrentHashMap.newKeySet();
    /** The pack each player still joining was handed, and their answer to it. */
    private final Map<UUID, Handed> handed = new ConcurrentHashMap<>();

    /** Kept until the player arrives; one who never does is forgotten after this. */
    private static final long HANDED_FOR_MILLIS = TimeUnit.MINUTES.toMillis(10);

    private record Handed(SoundConfig.Pack pack, String state, long at) {}

    private SoundPack(PolarisConfig link, String version) {
        this.client = new PolarisClient(link, version);
        this.path = "/api/minecraft/sounds/" + link.serverId();
    }

    /** Started where Polaris has said where it is and sounds are not switched off. */
    static SoundPack start(String version) {
        if (!SoundConfig.wanted(System.getenv())) {
            PolarisMod.LOG.info("Polaris sounds are switched off for this server.");
            return null;
        }
        PolarisConfig link = PolarisConfig.linkFromEnvironment(System.getenv());
        if (link.state() != PolarisConfig.State.ON) return null;
        instance = new SoundPack(link, version);
        return instance;
    }

    static SoundPack instance() {
        return instance;
    }

    @SubscribeEvent
    public void onServerStarted(ServerStartedEvent event) {
        refresh(event.getServer());
    }

    /** Ask Polaris again; the answer is applied on the game thread. A failure
     *  keeps what the server has and asks again in a minute. */
    void refresh(MinecraftServer server) {
        client.get(path).thenAccept(reply -> {
            SoundConfig fresh = reply.reached() && reply.status() == 200 ? SoundConfig.parse(reply.body()) : null;
            if (fresh == null) {
                PolarisMod.LOG.warn("Polaris sounds could not be read ({}); asking again in a minute.",
                        reply.reached() ? "HTTP " + reply.status() : reply.unreachable());
                CompletableFuture.delayedExecutor(RETRY_SECONDS, TimeUnit.SECONDS).execute(() -> {
                    MinecraftServer running = ServerLifecycleHooks.getCurrentServer();
                    if (running != null && running.isRunning()) refresh(running);
                });
                return;
            }
            server.execute(() -> apply(server, fresh));
        });
    }

    private void apply(MinecraftServer server, SoundConfig fresh) {
        SoundConfig.Pack before = config.pack();
        config = fresh;
        SoundConfig.Pack after = fresh.pack();
        if (!SoundConfig.differs(before, after)) return;
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            if (after == null) {
                if (before != null) player.connection.send(new ClientboundResourcePackPopPacket(Optional.of(before.id())));
                player.removeTag(SoundConfig.LOADED_TAG);
                states.remove(player.getUUID());
            } else {
                push(player, after);
            }
        }
        if (after == null) PolarisMod.LOG.info("Polaris sounds: no pack to hand out.");
        else PolarisMod.LOG.info("Polaris sounds: handing out pack {}.", after.sha1());
    }

    private void push(ServerPlayer player, SoundConfig.Pack pack) {
        // Until the game says it loaded this one, the player hears the game's
        // own sounds: a sound named in a pack it does not have yet is silence.
        player.removeTag(SoundConfig.LOADED_TAG);
        states.put(player.getUUID(), "pending");
        player.connection.send(new ClientboundResourcePackPushPacket(
                pack.id(), pack.url(), pack.sha1(), pack.required(), pack.prompt().map(Component::literal)));
    }

    /**
     * A player's game connecting (on the mod bus): the pack goes into the same
     * queue as the server's own, so the game loads it before the player is
     * placed in the world. The answer comes back through {@link
     * #onJoiningResponse}; vanilla's own listener moves on to the next task.
     */
    void onConfigure(RegisterConfigurationTasksEvent event) {
        // An answer kept from an earlier attempt to join no longer counts.
        if (event.getListener() instanceof ServerConfigurationPacketListenerImpl joining)
            handed.remove(joining.getOwner().getId());
        SoundConfig.Pack pack = config.pack();
        if (pack == null) return;
        event.register(new ServerResourcePackConfigurationTask(new MinecraftServer.ServerResourcePackInfo(
                pack.id(), pack.url(), pack.sha1(), pack.required(), pack.prompt().map(Component::literal).orElse(null))));
    }

    /** A joining player's answer to the pack, on the game thread; see {@link #onResponse}. */
    boolean onJoiningResponse(ServerConfigurationPacketListenerImpl listener, UUID packId,
            ServerboundResourcePackPacket.Action action) {
        SoundConfig.Pack pack = config.pack();
        if (pack == null || !pack.id().equals(packId)) return false;
        long now = System.currentTimeMillis();
        handed.values().removeIf(one -> now - one.at() > HANDED_FOR_MILLIS);
        handed.put(listener.getOwner().getId(), new Handed(pack, SoundConfig.state(action.name()), now));
        if (action == ServerboundResourcePackPacket.Action.DECLINED && pack.required())
            listener.disconnect(Component.translatable("multiplayer.requiredTexturePrompt.disconnect"));
        return true;
    }

    @SubscribeEvent
    public void onJoin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        player.removeTag(SoundConfig.LOADED_TAG);
        if (player.addTag(SoundConfig.SEEN_TAG)) welcomeOwed.add(player.getUUID());
        SoundConfig current = config;
        // Everybody who has the sounds hears this one arrive (before the
        // player's own answer counts, so not they themselves).
        SoundConfig.Sound arrival = current.arrival(player.getGameProfile().getName());
        if (arrival != null) run(player.getServer(), arrival.command("@a[tag=" + SoundConfig.LOADED_TAG + "]"));
        Handed early = handed.remove(player.getUUID());
        if (current.pack() != null) {
            // Handed while joining, and still the one: not sent again, since
            // that would reload the player's game a second time.
            if (early != null && !SoundConfig.differs(early.pack(), current.pack())) settle(player, early.state());
            else push(player, current.pack());
        }
    }

    @SubscribeEvent
    public void onLeave(PlayerEvent.PlayerLoggedOutEvent event) {
        UUID id = event.getEntity().getUUID();
        states.remove(id);
        welcomeOwed.remove(id);
    }

    /**
     * A player's answer to a pack, on the game thread. Answers whether it was
     * this one's (and so handled here): a pack the server itself requires must
     * not be the reason somebody who turned down an optional one of ours is
     * disconnected.
     */
    boolean onResponse(ServerPlayer player, UUID packId, ServerboundResourcePackPacket.Action action) {
        SoundConfig.Pack pack = config.pack();
        if (pack == null || !pack.id().equals(packId)) return false;
        switch (action) {
            case SUCCESSFULLY_LOADED -> settle(player, "loaded");
            case DECLINED -> {
                states.put(player.getUUID(), "declined");
                if (pack.required())
                    player.connection.disconnect(Component.translatable("multiplayer.requiredTexturePrompt.disconnect"));
            }
            case FAILED_DOWNLOAD, INVALID_URL, FAILED_RELOAD, DISCARDED -> states.put(player.getUUID(), "failed");
            default -> states.putIfAbsent(player.getUUID(), "pending");
        }
        return true;
    }

    /** Where a player's answer leaves them: one whose game loaded the pack hears
     *  the server's sounds from now on, and the welcome if it is their first visit. */
    private void settle(ServerPlayer player, String state) {
        states.put(player.getUUID(), state);
        if (!state.equals("loaded")) return;
        player.addTag(SoundConfig.LOADED_TAG);
        SoundConfig.Sound welcome = config.welcome();
        if (welcomeOwed.remove(player.getUUID()) && welcome != null)
            run(player.getServer(), welcome.command(player.getStringUUID()));
    }

    /** {@code polaris sounds status}: the pack and who has it. */
    JsonObject status(MinecraftServer server) {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        SoundConfig.Pack pack = config.pack();
        reply.addProperty("sha1", pack == null ? "" : pack.sha1());
        JsonArray players = new JsonArray();
        if (pack != null) {
            for (ServerPlayer player : server.getPlayerList().getPlayers()) {
                JsonObject one = new JsonObject();
                one.addProperty("name", player.getGameProfile().getName());
                one.addProperty("state", states.getOrDefault(player.getUUID(), "pending"));
                players.add(one);
            }
        }
        reply.add("players", players);
        return reply;
    }

    /** {@code polaris sounds refresh}: answered at once, applied when Polaris answers. */
    JsonObject refreshNow(MinecraftServer server) {
        refresh(server);
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        return reply;
    }

    private static void run(MinecraftServer server, String command) {
        if (server == null) return;
        CommandSourceStack source = server.createCommandSourceStack().withSuppressedOutput();
        server.getCommands().performPrefixedCommand(source, command);
    }
}
