package polaris.minecraft;

import java.util.Locale;
import java.util.Set;
import org.bukkit.ChatColor;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;

/**
 * What an impostor game's dead say reaches only the other dead.
 *
 * A player killed in the game is tagged {@link #GHOST_TAG} by the dashboard
 * and watches as a spectator; their chat goes only to players who carry the
 * tag, marked as a ghost's, so they cannot tell the living who killed them.
 * The commands that would carry it round that ({@code /msg}, {@code /me},
 * {@code /teammsg} and the like) are refused. The tag is taken off when the
 * event ends, so outside a game this does nothing.
 */
final class EventGhosts implements Listener {
    static final String GHOST_TAG = "pe_im_ghost";

    private static final Set<String> TALK_COMMANDS = Set.of("msg", "tell", "w", "me", "teammsg", "tm", "say");

    private static final String ONLY_GHOSTS =
            "Only other ghosts hear you until the game ends. / Solo te oyen otros fantasmas hasta que acabe la partida.";

    private static boolean ghost(Player player) {
        return player.getScoreboardTags().contains(GHOST_TAG);
    }

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onChat(AsyncPlayerChatEvent event) {
        if (!ghost(event.getPlayer())) return;
        try {
            event.getRecipients().removeIf(recipient -> !ghost(recipient));
        } catch (UnsupportedOperationException fixed) {
            // A plugin made the list fixed: nothing is said rather than said to the living.
            event.setCancelled(true);
            return;
        }
        event.setFormat(ChatColor.DARK_GRAY + "[%1$s] " + ChatColor.GRAY + ChatColor.ITALIC + "%2$s");
    }

    @EventHandler(priority = EventPriority.LOW, ignoreCancelled = true)
    public void onCommand(PlayerCommandPreprocessEvent event) {
        if (!ghost(event.getPlayer())) return;
        String input = event.getMessage().trim();
        if (input.startsWith("/")) input = input.substring(1);
        int space = input.indexOf(' ');
        String root = (space < 0 ? input : input.substring(0, space)).toLowerCase(Locale.ROOT);
        int colon = root.indexOf(':');
        if (colon >= 0) root = root.substring(colon + 1);
        if (!TALK_COMMANDS.contains(root)) return;
        event.setCancelled(true);
        event.getPlayer().sendMessage(ChatColor.GRAY + ONLY_GHOSTS);
    }
}
