package polaris.minecraft;

import java.util.Locale;
import java.util.Set;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.CommandEvent;
import net.neoforged.neoforge.event.ServerChatEvent;

/**
 * What an impostor game's dead say reaches only the other dead.
 *
 * A player killed in the game is tagged {@link #GHOST_TAG} by the dashboard
 * and watches as a spectator; whatever they type is cancelled and sent, marked
 * as a ghost's, to every player who carries the tag, so they cannot tell the
 * living who killed them. The commands that would carry it round that
 * ({@code /msg}, {@code /me}, {@code /teammsg} and the like) are refused. The
 * tag is taken off when the event ends, so outside a game this does nothing.
 *
 * Chat moderation ({@link ChatModeration}) runs first, at the highest priority,
 * so a line it stops is never passed on here.
 */
final class EventGhosts {
    static final String GHOST_TAG = "pe_im_ghost";

    private static final Set<String> TALK_COMMANDS = Set.of("msg", "tell", "w", "me", "teammsg", "tm", "say");

    private static final String ONLY_GHOSTS =
            "Only other ghosts hear you until the game ends. / Solo te oyen otros fantasmas hasta que acabe la partida.";

    private static boolean ghost(ServerPlayer player) {
        return player.getTags().contains(GHOST_TAG);
    }

    @SubscribeEvent
    public void onChat(ServerChatEvent event) {
        ServerPlayer player = event.getPlayer();
        if (!ghost(player)) return;
        event.setCanceled(true);
        MinecraftServer server = player.getServer();
        if (server == null) return;
        Component line = Component.literal("[" + player.getGameProfile().getName() + "] ")
                .withStyle(ChatFormatting.DARK_GRAY)
                .append(Component.literal(event.getRawText()).withStyle(ChatFormatting.GRAY, ChatFormatting.ITALIC));
        for (ServerPlayer other : server.getPlayerList().getPlayers()) {
            if (ghost(other)) other.sendSystemMessage(line);
        }
    }

    @SubscribeEvent
    public void onCommand(CommandEvent event) {
        ServerPlayer player = event.getParseResults().getContext().getSource().getPlayer();
        if (player == null || !ghost(player)) return;
        String input = event.getParseResults().getReader().getString().trim();
        if (input.startsWith("/")) input = input.substring(1);
        int space = input.indexOf(' ');
        String root = (space < 0 ? input : input.substring(0, space)).toLowerCase(Locale.ROOT);
        if (root.startsWith("minecraft:")) root = root.substring("minecraft:".length());
        if (!TALK_COMMANDS.contains(root)) return;
        event.setCanceled(true);
        player.sendSystemMessage(Component.literal(ONLY_GHOSTS).withStyle(ChatFormatting.GRAY));
    }
}
