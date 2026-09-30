package polaris.anticheat.platform.bukkit.chat;

import java.util.Locale;
import java.util.logging.Logger;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.Plugin;
import polaris.minecraft.chat.ChatGuard;
import polaris.minecraft.chat.ChatLink;

/**
 * The server's chat held to the rules set on its Moderation tab in Polaris, on
 * Paper, Purpur, Spigot and Folia.
 *
 * Vanilla has no way to stop a chat line; a plugin does, by cancelling the chat
 * event before the line is sent to anybody. So does the same text sent through
 * {@code /msg}, {@code /me} and the like, which would otherwise be the way round
 * it. The rules and the engine are the Polaris mod's (`polaris-common`, source
 * root `src/chat`), so both kinds of server stop the same lines. Operators, and
 * whoever holds {@code polaris.chat.bypass}, are left alone.
 *
 * Runs only where Polaris switched the anti-cheat on and said where it is.
 */
public final class BukkitChatModeration implements Listener {
    private static final Logger LOG = Logger.getLogger("PolarisAntiCheat");
    private static final String BYPASS = "polaris.chat.bypass";

    private final ChatGuard guard;
    private final ChatLink link;

    private BukkitChatModeration(ChatGuard guard, ChatLink link) {
        this.guard = guard;
        this.link = link;
    }

    /** Register moderation on this server, when Polaris runs it. */
    public static void register(Plugin plugin) {
        String flag = System.getenv().getOrDefault("POLARIS_ANTICHEAT", "").trim().toLowerCase(Locale.ROOT);
        if (!flag.equals("on")) return;
        ChatGuard guard = new ChatGuard();
        ChatLink link = ChatLink.start(System.getenv(), plugin.getDescription().getVersion(), guard, LOG::info);
        if (link == null) return;
        Bukkit.getPluginManager().registerEvents(new BukkitChatModeration(guard, link), plugin);
    }

    private boolean exempt(Player player) {
        return guard.rules().exemptOperators() && (player.isOp() || player.hasPermission(BYPASS));
    }

    @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
    public void onChat(AsyncPlayerChatEvent event) {
        Player player = event.getPlayer();
        if (exempt(player)) return;
        String line = event.getMessage();
        ChatGuard.Verdict verdict = guard.check(player.getUniqueId(), line, System.currentTimeMillis());
        if (verdict == null) return;
        event.setCancelled(true);
        stopped(player, verdict, line, false);
    }

    @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
    public void onCommand(PlayerCommandPreprocessEvent event) {
        Player player = event.getPlayer();
        if (exempt(player)) return;
        String line = guard.chatInCommand(event.getMessage());
        if (line == null) return;
        ChatGuard.Verdict verdict = guard.check(player.getUniqueId(), line, System.currentTimeMillis());
        if (verdict == null) return;
        event.setCancelled(true);
        stopped(player, verdict, line, true);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        guard.forget(event.getPlayer().getUniqueId());
        link.forget(event.getPlayer().getUniqueId());
    }

    private void stopped(Player player, ChatGuard.Verdict verdict, String line, boolean command) {
        LOG.info("Chat from " + player.getName() + " not sent (" + verdict.reason() + "): " + line);
        // Sending a message to a player is safe from any thread on these servers.
        link.report(player.getName(), player.getUniqueId(), verdict, line, command, warning -> {
            if (player.isOnline()) player.sendMessage(ChatColor.RED + warning);
        });
    }
}
