package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import org.bukkit.Bukkit;
import org.bukkit.SoundCategory;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerResourcePackStatusEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

/**
 * The server's own sounds, handed to its players live.
 *
 * Polaris builds a resource pack from the sounds uploaded on the server's Sounds
 * tab; this asks for it when the plugin starts and whenever the dashboard says
 * it changed ({@code polaris sounds refresh}), and pushes it to everybody on and
 * everybody who joins - under an id of its own, so it stacks on top of the
 * server's own pack instead of replacing it, and a new one replaces the last.
 *
 * On Paper 1.21.7 and later a joining player is handed it while their game is
 * still connecting (the configuration phase, as the server's own pack is; see
 * {@code SoundPackConfigure}), so the reload it costs happens behind the joining
 * screen instead of on a second screen once they are in the world. Elsewhere,
 * and for anybody who joined before Polaris answered, it goes out on arrival.
 *
 * A player whose game has loaded it carries the {@link SoundConfig#LOADED_TAG}
 * scoreboard tag, which is what the dashboard's commands play the server's
 * sounds to; the rest hear the game's own. A player who turns down a pack the
 * server requires is disconnected, with the line Polaris sends in the owner's
 * language.
 *
 * Where the server requires its own pack, the game disconnects a player who
 * turns down any pack at all, before a plugin hears of it, and the Bukkit API
 * has no way to tell that disconnect apart. So there the sound pack is handed
 * out as required too: the prompt says so, rather than an optional pack
 * costing the player their place.
 *
 * {@code polaris sounds status|refresh} answer one line of JSON, from the
 * console (and so RCON) only.
 */
final class SoundPack implements Listener, CommandExecutor {
    private static final long RETRY_TICKS = 60 * 20;

    private final JavaPlugin plugin;
    private final PolarisClient client;
    private final String path;
    private volatile SoundConfig config = SoundConfig.NONE;
    private final Map<UUID, String> states = new ConcurrentHashMap<>();
    private final Set<UUID> welcomeOwed = ConcurrentHashMap.newKeySet();
    /** The pack each player still joining was handed, and their answer to it. */
    private final Map<UUID, Handed> handed = new ConcurrentHashMap<>();
    private BukkitTask retry;

    /** Kept until the player arrives; one who never does is forgotten after this. */
    private static final long HANDED_FOR_MILLIS = TimeUnit.MINUTES.toMillis(10);
    /** Where the configuration phase can be joined in on (Paper 1.21.7 and later). */
    private static final String CONFIGURE_EVENT =
            "io.papermc.paper.event.connection.configuration.AsyncPlayerConnectionConfigureEvent";

    private record Handed(SoundConfig.Pack pack, String state, long at) {}

    private SoundPack(JavaPlugin plugin, PolarisConfig link, String version) {
        this.plugin = plugin;
        this.client = new PolarisClient(link, version);
        this.path = "/api/minecraft/sounds/" + link.serverId();
    }

    /** Started where Polaris has said where it is and sounds are not switched off. */
    static SoundPack start(JavaPlugin plugin, String version) {
        if (!SoundConfig.wanted(System.getenv())) {
            plugin.getLogger().info("Polaris sounds are switched off for this server.");
            return null;
        }
        PolarisConfig link = PolarisConfig.linkFromEnvironment(System.getenv());
        if (link.state() != PolarisConfig.State.ON) return null;
        SoundPack pack = new SoundPack(plugin, link, version);
        Bukkit.getPluginManager().registerEvents(pack, plugin);
        pack.handOutWhileJoining();
        pack.refresh();
        return pack;
    }

    /**
     * Joins the configuration phase where the server has one. The listener is
     * compiled against Paper's API and loaded by name, so a server without it
     * (Spigot, or Paper before 1.21.7) never reads it and keeps the push on arrival.
     */
    private void handOutWhileJoining() {
        try {
            Class.forName(CONFIGURE_EVENT, false, SoundPack.class.getClassLoader());
        } catch (ClassNotFoundException absent) {
            return;
        }
        try {
            Listener listener = (Listener) Class.forName("polaris.minecraft.SoundPackConfigure")
                    .getDeclaredConstructor(SoundPack.class).newInstance(this);
            Bukkit.getPluginManager().registerEvents(listener, plugin);
        } catch (ReflectiveOperationException | LinkageError | ClassCastException failed) {
            plugin.getLogger().warning("Polaris sounds: the pack goes out once players are in the world ("
                    + failed + ").");
        }
    }

    /** The pack to hand a player now, or null. */
    SoundConfig.Pack current() {
        return config.pack();
    }

    /** Whether the game has to be told the pack is required: see the class notes. */
    static boolean requiredOf(SoundConfig.Pack pack) {
        return pack.required() || Bukkit.getServer().isResourcePackRequired();
    }

    /** A player starting to join: an answer kept from an earlier attempt no longer counts. */
    void joining(UUID player) {
        handed.remove(player);
    }

    /** A joining player's final answer to {@code pack}, from any thread. */
    void answeredWhileJoining(UUID player, SoundConfig.Pack pack, String state) {
        long now = System.currentTimeMillis();
        handed.values().removeIf(one -> now - one.at() > HANDED_FOR_MILLIS);
        handed.put(player, new Handed(pack, state, now));
    }

    void stop() {
        if (retry != null) retry.cancel();
        retry = null;
    }

    /** Ask Polaris again; the answer is applied on the main thread. A failure
     *  keeps what the server has and asks again in a minute. */
    void refresh() {
        client.get(path).thenAccept(reply -> {
            SoundConfig fresh = reply.reached() && reply.status() == 200 ? SoundConfig.parse(reply.body()) : null;
            sync(() -> {
                if (fresh != null) {
                    apply(fresh);
                    return;
                }
                plugin.getLogger().warning("Polaris sounds could not be read ("
                        + (reply.reached() ? "HTTP " + reply.status() : reply.unreachable())
                        + "); asking again in a minute.");
                if (retry != null) retry.cancel();
                retry = Bukkit.getScheduler().runTaskLater(plugin, this::refresh, RETRY_TICKS);
            });
        });
    }

    private void sync(Runnable task) {
        if (plugin.isEnabled()) Bukkit.getScheduler().runTask(plugin, task);
    }

    private void apply(SoundConfig fresh) {
        SoundConfig.Pack before = config.pack();
        config = fresh;
        SoundConfig.Pack after = fresh.pack();
        if (!SoundConfig.differs(before, after)) return;
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (after == null) {
                if (before != null) player.removeResourcePack(before.id());
                player.removeScoreboardTag(SoundConfig.LOADED_TAG);
                states.remove(player.getUniqueId());
            } else {
                push(player, after);
            }
        }
        if (after == null) plugin.getLogger().info("Polaris sounds: no pack to hand out.");
        else plugin.getLogger().info("Polaris sounds: handing out pack " + after.sha1() + ".");
    }

    private void push(Player player, SoundConfig.Pack pack) {
        // Until the game says it loaded this one, the player hears the game's
        // own sounds: a sound named in a pack it does not have yet is silence.
        player.removeScoreboardTag(SoundConfig.LOADED_TAG);
        states.put(player.getUniqueId(), "pending");
        player.addResourcePack(pack.id(), pack.url(), HexFormat.of().parseHex(pack.sha1()),
                pack.prompt().orElse(null), requiredOf(pack));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        player.removeScoreboardTag(SoundConfig.LOADED_TAG);
        if (player.addScoreboardTag(SoundConfig.SEEN_TAG)) welcomeOwed.add(player.getUniqueId());
        SoundConfig current = config;
        // Everybody who has the sounds hears this one arrive (before the
        // player's own answer counts, so not they themselves).
        SoundConfig.Sound arrival = current.arrival(player.getName());
        if (arrival != null) {
            for (Player other : Bukkit.getOnlinePlayers()) {
                if (other.getScoreboardTags().contains(SoundConfig.LOADED_TAG)) play(other, arrival);
            }
        }
        Handed early = handed.remove(player.getUniqueId());
        if (current.pack() != null) {
            // Handed while joining, and still the one: not sent again, since
            // that would reload the player's game a second time.
            if (early != null && !SoundConfig.differs(early.pack(), current.pack())) settle(player, early.state());
            else push(player, current.pack());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        UUID id = event.getPlayer().getUniqueId();
        states.remove(id);
        welcomeOwed.remove(id);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onStatus(PlayerResourcePackStatusEvent event) {
        SoundConfig.Pack pack = config.pack();
        if (pack == null || !pack.id().equals(event.getID())) return;
        Player player = event.getPlayer();
        switch (event.getStatus()) {
            case SUCCESSFULLY_LOADED -> settle(player, "loaded");
            case DECLINED -> {
                states.put(player.getUniqueId(), "declined");
                if (pack.required()) player.kickPlayer(pack.kick());
            }
            case FAILED_DOWNLOAD, INVALID_URL, FAILED_RELOAD, DISCARDED -> states.put(player.getUniqueId(), "failed");
            default -> states.putIfAbsent(player.getUniqueId(), "pending");
        }
    }

    /** Where a player's answer leaves them: one whose game loaded the pack hears
     *  the server's sounds from now on, and the welcome if it is their first visit. */
    private void settle(Player player, String state) {
        states.put(player.getUniqueId(), state);
        if (!state.equals("loaded")) return;
        player.addScoreboardTag(SoundConfig.LOADED_TAG);
        SoundConfig.Sound welcome = config.welcome();
        if (welcomeOwed.remove(player.getUniqueId()) && welcome != null) play(player, welcome);
    }

    private static void play(Player player, SoundConfig.Sound sound) {
        player.playSound(player.getLocation(), sound.id(), SoundCategory.MASTER, (float) sound.volume(), (float) sound.pitch());
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        sender.sendMessage(answer(sender, args).toString());
        return true;
    }

    private JsonObject answer(CommandSender sender, String[] args) {
        if (sender instanceof Player) return refused("console");
        if (args.length == 2 && args[0].equalsIgnoreCase("sounds")) {
            if (args[1].equalsIgnoreCase("status")) return status();
            if (args[1].equalsIgnoreCase("refresh")) {
                refresh();
                JsonObject reply = new JsonObject();
                reply.addProperty("ok", true);
                return reply;
            }
        }
        return refused("usage");
    }

    /** The answer where the server's sounds are off, for the same command. */
    static JsonObject refused(String why) {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", false);
        reply.addProperty("why", why);
        return reply;
    }

    private JsonObject status() {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        SoundConfig.Pack pack = config.pack();
        reply.addProperty("sha1", pack == null ? "" : pack.sha1());
        JsonArray players = new JsonArray();
        if (pack != null) {
            for (Player player : Bukkit.getOnlinePlayers()) {
                JsonObject one = new JsonObject();
                one.addProperty("name", player.getName());
                one.addProperty("state", states.getOrDefault(player.getUniqueId(), "pending"));
                players.add(one);
            }
        }
        reply.add("players", players);
        return reply;
    }
}
