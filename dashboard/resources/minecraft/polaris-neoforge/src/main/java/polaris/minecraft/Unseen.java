package polaris.minecraft;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientboundBossEventPacket;
import net.minecraft.network.protocol.game.ClientboundClearTitlesPacket;
import net.minecraft.network.protocol.game.ClientboundDisguisedChatPacket;
import net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetDisplayObjectivePacket;
import net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitlesAnimationPacket;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;
import net.minecraft.network.protocol.game.ClientboundTabListPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.bossevents.CustomBossEvent;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.scores.DisplaySlot;
import net.minecraft.world.scores.Objective;
import polaris.minecraft.mixin.BossEventPacketAccessor;

/**
 * What a player held at the login prompt is kept from seeing: everything but
 * the prompt.
 *
 * A held player carries the entity tag {@link #PENDING_TAG} for exactly as
 * long as they are held, which is what Polaris narrows every line it shows to
 * (`@a[tag=!polaris_pending]`) - so challenges, events, announcements and the
 * chat relay leave them out. What is already up when they arrive, and what
 * anything else puts up while they wait, is kept off their screen here:
 *
 * - Boss bars made with {@code /bossbar} are taken off their screen without
 *   taking them off the bar's list - the same thing the game does when a player
 *   leaves - so the bar comes back on its own as they are let in, and a bar
 *   that was handed to them while they waited comes with it.
 * - The side panel, the tab list's score and the score under names are blanked
 *   on their screen and put back as they are let in.
 * - Titles, the action bar, system chat, chat a console or a command block
 *   says, those bars' updates and the tab list's header and footer are not sent to
 *   them at all (the packet filter, {@code HeldPacketMixin}), except what the
 *   login gate itself says ({@link #speak}) and the answer to their own
 *   {@code /login} or {@code /register} ({@link #answering}). The last header
 *   and footer held back is sent as they are let in.
 *
 * The game's own bars - a dragon fight, a wither, a raid, another mod's - are
 * left alone: the game hands each out once, and one held back would never be
 * there again for the updates that follow it.
 *
 * Other players' chat still reaches them: each message is a link in a signed
 * chain the client checks, and one held back would have the client disconnect
 * on the next.
 *
 * Every method but {@link #blocks} runs on the server thread. The filter can be
 * asked from any thread, so the sets it reads are concurrent.
 */
public final class Unseen {
    /** Kept in step with `PENDING_TAG` in the dashboard (`prelogin.ts`) and the
     *  Paper plugin. */
    static final String PENDING_TAG = "polaris_pending";

    private static final Set<UUID> hidden = ConcurrentHashMap.newKeySet();
    /** Players whose own command is being answered this tick. */
    private static final Set<UUID> answered = ConcurrentHashMap.newKeySet();
    /** The last tab list header and footer held back from each held player. */
    private static final Map<UUID, ClientboundTabListPacket> deferredTab = new ConcurrentHashMap<>();
    /** The bars made with {@code /bossbar}, as of the start of this tick, for the
     *  filter asked off the server thread. */
    private static final Set<UUID> customBars = ConcurrentHashMap.newKeySet();
    private static final ThreadLocal<Boolean> speaking = ThreadLocal.withInitial(() -> false);

    private Unseen() {}

    /** Keep everything off a player's screen who has just been held. */
    static void hide(MinecraftServer server, ServerPlayer player) {
        player.addTag(PENDING_TAG);
        // Taken down before they count as hidden, so the packets that take each
        // thing off their screen are sent.
        for (CustomBossEvent bar : server.getCustomBossEvents().getEvents()) {
            if (bar.getPlayers().contains(player)) bar.onPlayerDisconnect(player);
        }
        for (DisplaySlot slot : DisplaySlot.values()) {
            if (server.getScoreboard().getDisplayObjective(slot) != null) {
                player.connection.send(new ClientboundSetDisplayObjectivePacket(slot, null));
            }
        }
        player.connection.send(new ClientboundClearTitlesPacket(true));
        hidden.add(player.getUUID());
    }

    /** A bar handed to a held player while they wait is taken off their screen
     *  again, kept on the bar's list for when they are let in. */
    static void keepHidden(MinecraftServer server, ServerPlayer player) {
        for (CustomBossEvent bar : server.getCustomBossEvents().getEvents()) {
            if (bar.getPlayers().contains(player)) bar.onPlayerDisconnect(player);
        }
    }

    /** Let a player see again: their bars, the panels, the header and footer. */
    static void show(MinecraftServer server, ServerPlayer player) {
        hidden.remove(player.getUUID());
        answered.remove(player.getUUID());
        player.removeTag(PENDING_TAG);
        for (CustomBossEvent bar : server.getCustomBossEvents().getEvents()) bar.onPlayerConnect(player);
        for (DisplaySlot slot : DisplaySlot.values()) {
            Objective objective = server.getScoreboard().getDisplayObjective(slot);
            if (objective != null) player.connection.send(new ClientboundSetDisplayObjectivePacket(slot, objective));
        }
        ClientboundTabListPacket tab = deferredTab.remove(player.getUUID());
        if (tab != null) player.connection.send(tab);
    }

    /**
     * A held player who left, or a server stopping with them held: the tag comes
     * off before they are saved, so nobody is ever written to disk as pending.
     * Their bars are untouched - they are still on each one's list, and the game
     * shows it to them on their next join.
     */
    static void forget(ServerPlayer player) {
        hidden.remove(player.getUUID());
        answered.remove(player.getUUID());
        deferredTab.remove(player.getUUID());
        player.removeTag(PENDING_TAG);
    }

    /** A tag left on a player by a server that stopped without saying so: taken
     *  off whenever a join finds it on somebody this gate is not holding. */
    static void clearStale(ServerPlayer player) {
        player.removeTag(PENDING_TAG);
    }

    /** Whatever the gate itself says to a held player. */
    static void speak(Runnable said) {
        boolean before = speaking.get();
        speaking.set(true);
        try {
            said.run();
        } finally {
            speaking.set(before);
        }
    }

    /** A held player typed {@code /login} or {@code /register}: what the game
     *  answers to it this tick - a usage line, a typo - reaches them. */
    static void answering(ServerPlayer player) {
        if (hidden.contains(player.getUUID())) answered.add(player.getUUID());
    }

    /** The start of every tick: the answers of the last one are done. */
    static void nextTick(MinecraftServer server) {
        if (!answered.isEmpty()) answered.clear();
        if (hidden.isEmpty()) {
            customBars.clear();
            return;
        }
        Set<UUID> now = new HashSet<>();
        for (CustomBossEvent bar : server.getCustomBossEvents().getEvents()) now.add(bar.getId());
        customBars.retainAll(now);
        customBars.addAll(now);
    }

    /** Whether a boss bar packet is about a bar made with {@code /bossbar}: the
     *  only ones taken off a held player's screen and handed back as they are let
     *  in. Every one when the packet cannot be read. */
    private static boolean customBar(Packet<?> packet, ServerPlayer player) {
        if (!(packet instanceof BossEventPacketAccessor fields)) return true;
        UUID id = fields.polaris$id();
        MinecraftServer server = player.server;
        if (server == null || !server.isSameThread()) return customBars.contains(id);
        for (CustomBossEvent bar : server.getCustomBossEvents().getEvents()) {
            if (bar.getId().equals(id)) return true;
        }
        return false;
    }

    /** Whether a packet on its way to this player is one a held player does not get. */
    public static boolean blocks(Packet<?> packet, ServerPlayer player) {
        if (hidden.isEmpty() || !hidden.contains(player.getUUID()) || speaking.get()) return false;
        if (packet instanceof ClientboundSystemChatPacket) return !answered.contains(player.getUUID());
        if (packet instanceof ClientboundTabListPacket tab) {
            deferredTab.put(player.getUUID(), tab);
            return true;
        }
        if (packet instanceof ClientboundBossEventPacket) return customBar(packet, player);
        return packet instanceof ClientboundSetDisplayObjectivePacket
                || packet instanceof ClientboundSetTitleTextPacket
                || packet instanceof ClientboundSetSubtitleTextPacket
                || packet instanceof ClientboundSetActionBarTextPacket
                || packet instanceof ClientboundSetTitlesAnimationPacket
                || packet instanceof ClientboundClearTitlesPacket
                || packet instanceof ClientboundDisguisedChatPacket;
    }
}
