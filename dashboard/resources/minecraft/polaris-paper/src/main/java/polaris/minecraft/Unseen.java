package polaris.minecraft;

import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.bukkit.Bukkit;
import org.bukkit.NamespacedKey;
import org.bukkit.boss.KeyedBossBar;
import org.bukkit.entity.Player;
import org.bukkit.scoreboard.Scoreboard;

/**
 * What a player held at the login prompt is kept from seeing: everything but
 * the prompt.
 *
 * A held player carries the scoreboard tag {@link #PENDING_TAG} for exactly as
 * long as they are held, which is what Polaris narrows every line it shows to
 * ({@code @a[tag=!polaris_pending]}) - so challenges, events, announcements and
 * the chat relay leave them out. What is already up when they arrive, and what
 * is put up while they wait, is kept off their screen here:
 *
 * - Boss bars made with {@code /bossbar} are taken off them and remembered, and
 *   a bar handed to them while they wait is taken off again on the next tick.
 *   Every one comes back as they are let in, and as they leave, so the bar's
 *   list - which the game keeps across joins - is what it would have been.
 * - The side panel, the tab list's score and the score under names: they are
 *   given a scoreboard of their own with nothing on it, and their own back as
 *   they are let in.
 * - Other players' chat is not delivered to them ({@code LoginGate#onChatSeen}).
 *
 * All of it runs on the main thread, apart from the chat, which only reads
 * whether somebody is held.
 */
final class Unseen {
    /** Kept in step with `PENDING_TAG` in the dashboard (`prelogin.ts`) and the
     *  NeoForge mod. */
    static final String PENDING_TAG = "polaris_pending";

    /** The bars taken off each held player. */
    private final Map<UUID, Set<NamespacedKey>> bars = new ConcurrentHashMap<>();
    /** The scoreboard each held player had, and the blank one they were given. */
    private final Map<UUID, Scoreboard[]> boards = new ConcurrentHashMap<>();

    /** Keep everything off a player's screen who has just been held. */
    void hide(Player player) {
        player.addScoreboardTag(PENDING_TAG);
        bars.put(player.getUniqueId(), new HashSet<>());
        keepHidden(player);
        if (Bukkit.getScoreboardManager() != null) {
            Scoreboard blank = Bukkit.getScoreboardManager().getNewScoreboard();
            boards.put(player.getUniqueId(), new Scoreboard[] {player.getScoreboard(), blank});
            player.setScoreboard(blank);
        }
        player.resetTitle();
    }

    /** A bar handed to a held player is taken off them again, and remembered. */
    void keepHidden(Player player) {
        Set<NamespacedKey> taken = bars.get(player.getUniqueId());
        if (taken == null) return;
        for (Iterator<KeyedBossBar> it = Bukkit.getBossBars(); it.hasNext(); ) {
            KeyedBossBar bar = it.next();
            if (bar.getPlayers().contains(player)) {
                bar.removePlayer(player);
                taken.add(bar.getKey());
            }
        }
    }

    /**
     * Give back what was kept from them: as they are let in, and as they leave
     * held - the bars so the game's own list of who sees each one is whole again
     * for their next join, the scoreboard because it is theirs.
     */
    void show(Player player) {
        player.removeScoreboardTag(PENDING_TAG);
        Set<NamespacedKey> taken = bars.remove(player.getUniqueId());
        if (taken != null) {
            for (NamespacedKey key : taken) {
                KeyedBossBar bar = Bukkit.getBossBar(key);
                if (bar != null) bar.addPlayer(player);
            }
        }
        Scoreboard[] board = boards.remove(player.getUniqueId());
        // Only the blank one is taken back: a scoreboard another plugin gave
        // them while they waited is that plugin's.
        if (board != null && player.getScoreboard() == board[1]) player.setScoreboard(board[0]);
    }

    /** Whether somebody is held, from any thread. */
    boolean hides(UUID id) {
        return bars.containsKey(id);
    }

    /** A tag left on a player by a server that stopped without saying so. */
    static void clearStale(Player player) {
        player.removeScoreboardTag(PENDING_TAG);
    }
}
