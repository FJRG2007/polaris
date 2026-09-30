package polaris.minecraft;

import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.CommandEvent;
import net.neoforged.neoforge.event.ServerChatEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import polaris.minecraft.chat.ChatGuard;
import polaris.minecraft.chat.ChatLink;

/**
 * The server's chat held to the rules set on its Moderation tab in Polaris.
 *
 * A chat line that breaks one is cancelled before anybody else sees it, and so is
 * the same text sent through {@code /msg}, {@code /me} and the like, which would
 * otherwise be the way round it. The player is told why, in their own language,
 * with what Polaris answers when it is told about the line; Polaris is also what
 * times a player out after repeats. Operators are left alone.
 *
 * Only chat players type is looked at. Messages the server or other mods send to
 * players are not: there is no event for them, only the packet, and a filter
 * there would also have to decide about command output, death messages and every
 * mod's own feedback, where a false match hides something a player needed.
 */
final class ChatModeration {
    /** Operator level 2: the one that may use /kick and /ban. */
    private static final int OPERATOR_LEVEL = 2;

    private final ChatGuard guard;
    private final ChatLink link;

    private ChatModeration(ChatGuard guard, ChatLink link) {
        this.guard = guard;
        this.link = link;
    }

    /** Moderation for this server, or null when the environment has no Polaris
     *  to take rules from. */
    static ChatModeration start(String version) {
        ChatGuard guard = new ChatGuard();
        ChatLink link = ChatLink.start(System.getenv(), version, guard, PolarisMod.LOG::info);
        return link == null ? null : new ChatModeration(guard, link);
    }

    private boolean exempt(ServerPlayer player) {
        return guard.rules().exemptOperators() && player.hasPermissions(OPERATOR_LEVEL);
    }

    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onChat(ServerChatEvent event) {
        ServerPlayer player = event.getPlayer();
        if (exempt(player)) return;
        String line = event.getRawText();
        ChatGuard.Verdict verdict = guard.check(player.getUUID(), line, System.currentTimeMillis());
        if (verdict == null) return;
        event.setCanceled(true);
        stopped(player, verdict, line, false);
    }

    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onCommand(CommandEvent event) {
        ServerPlayer player = event.getParseResults().getContext().getSource().getPlayer();
        if (player == null || exempt(player)) return;
        String line = guard.chatInCommand(event.getParseResults().getReader().getString());
        if (line == null) return;
        ChatGuard.Verdict verdict = guard.check(player.getUUID(), line, System.currentTimeMillis());
        if (verdict == null) return;
        event.setCanceled(true);
        stopped(player, verdict, line, true);
    }

    @SubscribeEvent
    public void onLeave(PlayerEvent.PlayerLoggedOutEvent event) {
        guard.forget(event.getEntity().getUUID());
        link.forget(event.getEntity().getUUID());
    }

    private void stopped(ServerPlayer player, ChatGuard.Verdict verdict, String line, boolean command) {
        PolarisMod.LOG.info("Chat from {} not sent ({}): {}", player.getGameProfile().getName(), verdict.reason(), line);
        MinecraftServer server = player.getServer();
        link.report(player.getGameProfile().getName(), player.getUUID(), verdict, line, command, warning -> {
            if (server == null) return;
            server.execute(() -> {
                if (!player.hasDisconnected()) {
                    player.sendSystemMessage(Component.literal(warning).withStyle(ChatFormatting.RED));
                }
            });
        });
    }
}
