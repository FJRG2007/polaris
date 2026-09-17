package polaris.minecraft;

import com.google.gson.JsonObject;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiConsumer;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Location;
import org.bukkit.boss.BarColor;
import org.bukkit.boss.BarStyle;
import org.bukkit.boss.BossBar;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.PluginCommand;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.HandlerList;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.potion.PotionEffect;
import org.bukkit.potion.PotionEffectType;
import org.bukkit.scheduler.BukkitTask;
import polaris.minecraft.PolarisClient.Reply;

/**
 * Holds every player who joins until they have given their password.
 *
 * The same gate as the NeoForge mod, on the Bukkit API. A held player stands where
 * they joined, in the dark, with what to type in the middle of the screen and the
 * time they have left in a bar across the top. They cannot be hurt, and can do
 * nothing but {@code /login} and {@code /register}: no chat, no other command, no
 * blocks, no items, no attacks. Before any of that, Polaris is asked whether the
 * name is on the server's player list at all, and from that network - a name that
 * is not is turned away before it can register a password for somebody else's
 * account. Passwords are never kept here - every one is checked by Polaris - so a
 * server that cannot reach Polaris lets nobody through.
 *
 * All state is touched on the main thread. Answers from Polaris arrive on the HTTP
 * client's threads and are handed back through the scheduler, and chat - which
 * Bukkit fires off the main thread - only reads whether a player is held. A kick
 * is only ever carried out from the tick, so nobody is disconnected in the middle
 * of the event that noticed it.
 */
final class LoginGate implements Listener, CommandExecutor {
    private static final int SECOND = 20;
    private static final int LOGIN_TICKS = 60 * SECOND;
    private static final int HEARTBEAT_TICKS = 60 * SECOND;
    private static final int REMINDER_TICKS = 3 * SECOND;
    /** How long the title stays up. Longer than the gap between resends. */
    private static final int TITLE_TICKS = 5 * SECOND;
    /** When the bar turns red. */
    private static final int HURRY_SECONDS = 10;
    private static final int MAX_WRONG = 3;
    private static final int MIN_PASSWORD = 6;
    private static final int MAX_PASSWORD = 64;
    private static final Set<String> OPEN_COMMANDS = Set.of("login", "register");

    private static final String UNREACHABLE =
            "This server cannot reach Polaris to check your password, so nobody can join right now. Try again in a few minutes.";
    private static final String UNLINKED =
            "This server's link to Polaris is not valid, so nobody can join. Tell the server's owner.";
    private static final String NOT_SET_UP =
            "Polaris login is switched on for this server but not set up, so nobody can join. Tell the server's owner.";

    private final PolarisPlugin plugin;
    private final PolarisConfig config;
    private final PolarisClient client;
    private final String version;
    private final Map<UUID, Held> held = new ConcurrentHashMap<>();
    private BukkitTask ticker;
    private boolean guarding;
    private long tick;
    private boolean reachable = true;
    private boolean linked = true;

    /** One player waiting to log in. */
    private static final class Held {
        final Location anchor;
        final long deadline;
        final BossBar bar;
        /** Null until Polaris has said. */
        Boolean registered;
        boolean busy;
        int wrong;
        long remindedAt = -REMINDER_TICKS;
        String kick;
        /** Whether the darkness on their screen is this gate's, and so this gate's
         *  to lift. */
        boolean darkened;

        Held(Location anchor, long deadline, BossBar bar) {
            this.anchor = anchor;
            this.deadline = deadline;
            this.bar = bar;
        }
    }

    LoginGate(PolarisPlugin plugin, PolarisConfig config, PolarisClient client, String version) {
        this.plugin = plugin;
        this.config = config;
        this.client = client;
        this.version = version;
    }

    // ------------------------------------------------------------------ lifecycle

    void start() {
        guarding = !Bukkit.getOnlineMode();
        if (!guarding) {
            plugin.getLogger().warning(
                    "online-mode is on, so Mojang already checks who players are. Polaris login is not asking for passwords.");
        }
        for (String name : List.of("register", "login", "changepassword")) {
            PluginCommand command = plugin.getCommand(name);
            if (command != null) command.setExecutor(this);
        }
        Bukkit.getPluginManager().registerEvents(this, plugin);
        ticker = Bukkit.getScheduler().runTaskTimer(plugin, this::onTick, 1, 1);
        // A reload leaves players online who never passed through this gate.
        if (guarding) for (Player player : Bukkit.getOnlinePlayers()) hold(player);
        heartbeat();
    }

    void stop() {
        if (ticker != null) ticker.cancel();
        HandlerList.unregisterAll(this);
        for (Map.Entry<UUID, Held> entry : held.entrySet()) {
            Player player = Bukkit.getPlayer(entry.getKey());
            entry.getValue().bar.removeAll();
            if (player != null) lighten(player, entry.getValue());
        }
        held.clear();
    }

    private void onTick() {
        tick++;
        if (tick % HEARTBEAT_TICKS == 0) heartbeat();
        for (Map.Entry<UUID, Held> entry : new ArrayList<>(held.entrySet())) {
            Player player = Bukkit.getPlayer(entry.getKey());
            Held waiting = entry.getValue();
            if (player == null) {
                forget(entry.getKey());
            } else if (waiting.kick != null) {
                player.kickPlayer(waiting.kick);
            } else if (tick > waiting.deadline && !waiting.busy) {
                player.kickPlayer("You took too long to log in.");
            } else {
                if (tick % SECOND == 0) countdown(waiting);
                if (tick % (TITLE_TICKS - SECOND) == 0) titleFor(player, waiting);
            }
        }
    }

    private void heartbeat() {
        if (config.state() != PolarisConfig.State.ON) return;
        JsonObject body = new JsonObject();
        body.addProperty("mod", version);
        body.addProperty("minecraft", Bukkit.getBukkitVersion().split("-", 2)[0]);
        client.call("hello", body).thenAccept(reply -> onMain(() -> note(reply)));
    }

    /** Say in the log when Polaris stops or starts answering, once per change. */
    private void note(Reply reply) {
        if (!reply.reached()) {
            if (reachable) {
                plugin.getLogger().severe("Polaris cannot be reached at " + config.baseUrl() + " ("
                        + reply.unreachable() + "). Nobody can log in until it can.");
            }
            reachable = false;
            return;
        }
        if (!reachable) plugin.getLogger().info("Polaris is reachable again at " + config.baseUrl() + ".");
        reachable = true;
        boolean refused = reply.status() == 401;
        if (refused && linked) {
            plugin.getLogger().severe(
                    "Polaris refused this server's token. Nobody can log in until Polaris login is switched off and on again from the server's page.");
        } else if (!refused && !linked) {
            plugin.getLogger().info("Polaris accepts this server's token again.");
        }
        linked = !refused;
    }

    /** Run on the main thread, unless the plugin has been switched off meanwhile. */
    private void onMain(Runnable task) {
        if (plugin.isEnabled()) Bukkit.getScheduler().runTask(plugin, task);
    }

    // ------------------------------------------------------------------ joining

    @EventHandler(priority = EventPriority.LOWEST)
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        if (!guarding) {
            clearOurs(player);
            return;
        }
        hold(player);
    }

    private void hold(Player player) {
        BossBar bar = Bukkit.createBossBar(secondsLeft(LOGIN_TICKS / SECOND), BarColor.YELLOW, BarStyle.SOLID);
        Held waiting = new Held(player.getLocation(), tick + LOGIN_TICKS, bar);
        held.put(player.getUniqueId(), waiting);
        if (config.state() != PolarisConfig.State.ON) {
            clearOurs(player);
            waiting.kick = NOT_SET_UP;
            return;
        }
        bar.addPlayer(player);
        darken(player, waiting);
        title(player, "Checking your account", "One moment");
        waiting.busy = true;
        ask(player, waiting, "status", identity(player), (current, reply) -> {
            waiting.busy = false;
            if (!reply.reached()) {
                waiting.kick = UNREACHABLE;
            } else if (reply.status() == 401) {
                waiting.kick = UNLINKED;
            } else if (reply.status() != 200) {
                waiting.kick = "Polaris could not check your account (HTTP " + reply.status() + "). Try again in a minute.";
            } else if (!reply.text("refused").isEmpty()) {
                waiting.kick = reply.text("refused");
            } else {
                waiting.registered = reply.flag("registered");
                prompt(current, waiting);
            }
        });
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        Held waiting = held.get(event.getPlayer().getUniqueId());
        forget(event.getPlayer().getUniqueId());
        // Lifted before the player is saved, or they would wake up in the dark on
        // their next join with nothing to say it was this gate's.
        if (waiting != null) lighten(event.getPlayer(), waiting);
    }

    private void forget(UUID id) {
        Held waiting = held.remove(id);
        if (waiting != null) waiting.bar.removeAll();
    }

    /** The bar across the top: how long is left, draining, red at the end. */
    private void countdown(Held waiting) {
        long seconds = Math.max(0, (waiting.deadline - tick) / SECOND);
        waiting.bar.setTitle(secondsLeft(seconds));
        waiting.bar.setProgress(Math.max(0.0, Math.min(1.0, (double) seconds * SECOND / LOGIN_TICKS)));
        waiting.bar.setColor(seconds <= HURRY_SECONDS ? BarColor.RED : BarColor.YELLOW);
    }

    private static String secondsLeft(long seconds) {
        return seconds + (seconds == 1 ? " second" : " seconds") + " to log in";
    }

    /** The title for what this player has to do next, sent again before it fades. */
    private static void titleFor(Player player, Held waiting) {
        if (waiting.registered == null) return;
        if (waiting.registered) title(player, "Log in", "/login <password>");
        else title(player, "Choose a password", "/register <password> <password>");
    }

    private void prompt(Player player, Held waiting) {
        long seconds = Math.max(0, (waiting.deadline - tick) / SECOND);
        titleFor(player, waiting);
        if (Boolean.TRUE.equals(waiting.registered)) {
            tell(player, "Log in with /login <password>. You have " + seconds + " seconds.");
        } else {
            tell(player, "Choose a password for this server with /register <password> <password>. You have "
                    + seconds + " seconds. Put it in double quotes if it has spaces or symbols.");
        }
    }

    private void release(Player player, String message) {
        Held waiting = held.get(player.getUniqueId());
        forget(player.getUniqueId());
        if (waiting != null) lighten(player, waiting);
        player.resetTitle();
        player.sendMessage(ChatColor.GREEN + message);
    }

    /** What to do, in the middle of the screen. */
    private static void title(Player player, String title, String subtitle) {
        player.sendTitle(ChatColor.GOLD + title, ChatColor.YELLOW + subtitle, 0, TITLE_TICKS, 10);
    }

    /**
     * Dark until they are in. An endless blindness with no particles and no icon is
     * the mark this gate leaves, and the only one it takes away again.
     */
    private static void darken(Player player, Held waiting) {
        PotionEffect current = player.getPotionEffect(PotionEffectType.BLINDNESS);
        if (current != null && !isOurs(current)) return;
        player.addPotionEffect(new PotionEffect(
                PotionEffectType.BLINDNESS, PotionEffect.INFINITE_DURATION, 0, false, false, false));
        waiting.darkened = true;
    }

    private static void lighten(Player player, Held waiting) {
        if (waiting.darkened) clearOurs(player);
        waiting.darkened = false;
    }

    /** Lifts this gate's darkness, and only this gate's. */
    private static void clearOurs(Player player) {
        PotionEffect current = player.getPotionEffect(PotionEffectType.BLINDNESS);
        if (current != null && isOurs(current)) player.removePotionEffect(PotionEffectType.BLINDNESS);
    }

    private static boolean isOurs(PotionEffect effect) {
        return effect.isInfinite() && !effect.hasParticles() && !effect.hasIcon() && effect.getAmplifier() == 0;
    }

    // ------------------------------------------------------------------ commands

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage("Only players can use this.");
            return true;
        }
        List<String> words = PasswordArguments.split(String.join(" ", args));
        switch (command.getName().toLowerCase(Locale.ROOT)) {
            case "register" -> {
                if (words.size() != 2) return usage(player, "/register <password> <password>");
                register(player, words.get(0), words.get(1));
            }
            case "login" -> {
                if (words.size() != 1) return usage(player, "/login <password>");
                login(player, words.get(0));
            }
            case "changepassword" -> {
                if (words.size() != 2) return usage(player, "/changepassword <current> <new>");
                changePassword(player, words.get(0), words.get(1));
            }
            default -> {
                return false;
            }
        }
        return true;
    }

    private static boolean usage(Player player, String usage) {
        tell(player, "Use " + usage + ". Put a password in double quotes if it has spaces or symbols.");
        return true;
    }

    private void register(Player player, String password, String confirm) {
        Held waiting = waitingFor(player);
        if (waiting == null) return;
        if (Boolean.TRUE.equals(waiting.registered)) {
            tell(player, "You already have a password here. Log in with /login <password>.");
            return;
        }
        if (!password.equals(confirm)) {
            tell(player, "The two passwords are different. Type the same one twice.");
            return;
        }
        String problem = passwordProblem(password);
        if (problem != null) {
            tell(player, problem);
            return;
        }
        waiting.busy = true;
        JsonObject body = identity(player);
        body.addProperty("password", password);
        ask(player, waiting, "register", body, (current, reply) -> {
            waiting.busy = false;
            if (!reply.reached()) {
                tell(current, UNREACHABLE);
            } else if (!reply.text("refused").isEmpty()) {
                waiting.kick = reply.text("refused");
            } else if (reply.status() == 200) {
                release(current, "Password set. Welcome!");
            } else if (reply.status() == 409) {
                waiting.registered = true;
                tell(current, "You already have a password here. Log in with /login <password>.");
            } else {
                tell(current, failure(reply, "save your password"));
            }
        });
    }

    private void login(Player player, String password) {
        Held waiting = waitingFor(player);
        if (waiting == null) return;
        waiting.busy = true;
        JsonObject body = identity(player);
        body.addProperty("password", password);
        ask(player, waiting, "login", body, (current, reply) -> {
            waiting.busy = false;
            if (!reply.reached()) {
                tell(current, UNREACHABLE);
                return;
            }
            if (!reply.text("refused").isEmpty()) {
                waiting.kick = reply.text("refused");
                return;
            }
            switch (reply.status()) {
                case 200 -> release(current, "Logged in. Welcome back!");
                case 403 -> {
                    waiting.wrong++;
                    int left = MAX_WRONG - waiting.wrong;
                    if (left <= 0) waiting.kick = "Wrong password.";
                    else tell(current, "Wrong password. " + left + (left == 1 ? " try" : " tries") + " left.");
                }
                case 404 -> {
                    waiting.registered = false;
                    tell(current, "You have no password here yet. Choose one with /register <password> <password>.");
                }
                case 429 -> waiting.kick = throttled(reply);
                default -> tell(current, failure(reply, "check your password"));
            }
        });
    }

    private void changePassword(Player player, String current, String next) {
        if (!guarding) {
            tell(player, "This server checks accounts with Mojang, so there is no password here.");
            return;
        }
        if (held.containsKey(player.getUniqueId())) {
            tell(player, "Log in first with /login <password>.");
            return;
        }
        String problem = passwordProblem(next);
        if (problem != null) {
            tell(player, problem);
            return;
        }
        JsonObject body = identity(player);
        body.addProperty("current", current);
        body.addProperty("next", next);
        ask(player, null, "password", body, (online, reply) -> {
            if (!reply.reached()) {
                tell(online, "Polaris cannot be reached right now, so your password was not changed. Try again in a few minutes.");
                return;
            }
            switch (reply.status()) {
                case 200 -> online.sendMessage(ChatColor.GREEN + "Password changed.");
                case 403 -> tell(online, "Your current password is not that one.");
                case 429 -> tell(online, throttled(reply));
                default -> tell(online, failure(reply, "change your password"));
            }
        });
    }

    /** The held entry for a player about to log in, or null after telling them why not. */
    private Held waitingFor(Player player) {
        if (!guarding) {
            tell(player, "This server checks accounts with Mojang, so there is no password here.");
            return null;
        }
        Held waiting = held.get(player.getUniqueId());
        if (waiting == null) {
            tell(player, "You are already logged in.");
            return null;
        }
        if (waiting.busy) {
            tell(player, "Still checking, one moment.");
            return null;
        }
        return waiting;
    }

    private static String passwordProblem(String password) {
        if (password.length() < MIN_PASSWORD) return "A password needs at least " + MIN_PASSWORD + " characters.";
        if (password.length() > MAX_PASSWORD) return "A password can have at most " + MAX_PASSWORD + " characters.";
        return null;
    }

    private static String throttled(Reply reply) {
        long minutes = Math.max(1, (reply.number("retryAfterSeconds") + 59) / 60);
        return "Too many wrong passwords. Try again in " + minutes + (minutes == 1 ? " minute." : " minutes.");
    }

    private static String failure(Reply reply, String what) {
        if (reply.status() == 400 && !reply.text("message").isEmpty()) return reply.text("message") + ".";
        if (reply.status() == 401) return UNLINKED;
        return "Polaris could not " + what + " (HTTP " + reply.status() + "). Try again in a minute.";
    }

    private static JsonObject identity(Player player) {
        JsonObject body = new JsonObject();
        body.addProperty("player", player.getName());
        // Where they connect from, so Polaris can hold the name to the network it
        // is registered to, as the server's player list does.
        InetSocketAddress from = player.getAddress();
        if (from != null && from.getAddress() != null) body.addProperty("address", from.getAddress().getHostAddress());
        return body;
    }

    /**
     * Ask Polaris, and handle the answer on the main thread - but only if the
     * player is still online and, when {@code waiting} is given, still the same
     * wait. A player who left and came back has a new one, and an answer to the
     * old one must not log them in.
     */
    private void ask(Player player, Held waiting, String action, JsonObject body, BiConsumer<Player, Reply> then) {
        UUID id = player.getUniqueId();
        client.call(action, body).thenAccept(reply -> onMain(() -> {
            note(reply);
            Player online = Bukkit.getPlayer(id);
            if (online == null || (waiting != null && held.get(id) != waiting)) return;
            then.accept(online, reply);
        }));
    }

    private static void tell(Player player, String message) {
        player.sendMessage(ChatColor.GOLD + message);
    }

    // ------------------------------------------------------------------ holding

    private boolean isHeld(Entity entity) {
        return entity instanceof Player player && held.containsKey(player.getUniqueId());
    }

    /** Remind a held player what to do, at most every few seconds. */
    private void remind(Player player) {
        Held waiting = held.get(player.getUniqueId());
        if (waiting == null || waiting.busy || tick - waiting.remindedAt < REMINDER_TICKS) return;
        waiting.remindedAt = tick;
        if (waiting.registered != null) prompt(player, waiting);
    }

    @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
    public void onMove(PlayerMoveEvent event) {
        Held waiting = held.get(event.getPlayer().getUniqueId());
        if (waiting == null || event.getTo() == null) return;
        Location to = event.getTo();
        Location anchor = waiting.anchor;
        if (to.getWorld() != anchor.getWorld() || to.distanceSquared(anchor) > 0.01) {
            // Looking around is fine; going anywhere is not.
            Location back = anchor.clone();
            back.setYaw(to.getYaw());
            back.setPitch(to.getPitch());
            event.setTo(back);
        }
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onChat(AsyncPlayerChatEvent event) {
        if (!isHeld(event.getPlayer())) return;
        event.setCancelled(true);
        Player player = event.getPlayer();
        onMain(() -> remind(player));
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onCommand(PlayerCommandPreprocessEvent event) {
        if (!isHeld(event.getPlayer())) return;
        String input = event.getMessage().trim();
        if (input.startsWith("/")) input = input.substring(1);
        int space = input.indexOf(' ');
        String root = (space < 0 ? input : input.substring(0, space)).toLowerCase(Locale.ROOT);
        if (root.startsWith("polaris:")) root = root.substring("polaris:".length());
        if (OPEN_COMMANDS.contains(root)) return;
        event.setCancelled(true);
        remind(event.getPlayer());
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onBreak(BlockBreakEvent event) {
        if (isHeld(event.getPlayer())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onPlace(BlockPlaceEvent event) {
        if (isHeld(event.getPlayer())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onInteract(PlayerInteractEvent event) {
        if (isHeld(event.getPlayer())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onInteractEntity(PlayerInteractEntityEvent event) {
        if (isHeld(event.getPlayer())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onAttack(EntityDamageByEntityEvent event) {
        if (isHeld(event.getDamager())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onHurt(EntityDamageEvent event) {
        if (isHeld(event.getEntity())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onDrop(PlayerDropItemEvent event) {
        if (isHeld(event.getPlayer())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onPickup(EntityPickupItemEvent event) {
        if (isHeld(event.getEntity())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onInventory(InventoryClickEvent event) {
        if (isHeld(event.getWhoClicked())) event.setCancelled(true);
    }
}
