package polaris.minecraft;

import static polaris.minecraft.PolarisMod.LOG;

import com.google.gson.JsonObject;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiConsumer;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.common.util.TriState;
import net.neoforged.neoforge.event.CommandEvent;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.ServerChatEvent;
import net.neoforged.neoforge.event.entity.item.ItemTossEvent;
import net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent;
import net.neoforged.neoforge.event.entity.player.AttackEntityEvent;
import net.neoforged.neoforge.event.entity.player.ItemEntityPickupEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.neoforged.neoforge.event.level.BlockEvent;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.PlayerTickEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import polaris.minecraft.PolarisClient.Reply;

/**
 * Holds every player who joins until they have given their password.
 *
 * A held player stands where they joined, cannot be hurt, and can do nothing but
 * {@code /login} and {@code /register}: no chat, no other command, no blocks, no
 * items, no attacks. Passwords are never kept here - every one is checked by
 * Polaris - so a server that cannot reach Polaris lets nobody through. That is the
 * point: the alternative is letting anybody through on a name, which is the gap
 * this closes. It is said to the player and written to the log each time.
 *
 * All state lives on the server thread. Answers from Polaris arrive on the HTTP
 * client's threads and are handed back with {@code server.execute} before they
 * touch anything, and a kick is only ever carried out from the server tick, so
 * nothing is disconnected in the middle of the event that noticed it.
 */
final class LoginGate {
    private static final int SECOND = 20;
    private static final int LOGIN_TICKS = 60 * SECOND;
    private static final int HEARTBEAT_TICKS = 60 * SECOND;
    private static final int REMINDER_TICKS = 3 * SECOND;
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

    private final PolarisConfig config;
    private final PolarisClient client;
    private final String modVersion;
    private final Map<UUID, Held> held = new HashMap<>();
    private MinecraftServer server;
    private boolean guarding;
    private long tick;
    private boolean reachable = true;
    private boolean linked = true;

    /** One player waiting to log in. */
    private static final class Held {
        final Vec3 anchor;
        final long deadline;
        /** Null until Polaris has said. */
        Boolean registered;
        boolean busy;
        int wrong;
        /** Far enough back that the first reminder is never held back, and near
         *  enough that subtracting it from the tick cannot overflow. */
        long remindedAt = -REMINDER_TICKS;
        String kick;

        Held(Vec3 anchor, long deadline) {
            this.anchor = anchor;
            this.deadline = deadline;
        }
    }

    LoginGate(PolarisConfig config, PolarisClient client, String modVersion) {
        this.config = config;
        this.client = client;
        this.modVersion = modVersion;
    }

    // ------------------------------------------------------------------ lifecycle

    @SubscribeEvent
    public void onServerStarted(ServerStartedEvent event) {
        server = event.getServer();
        guarding = !server.usesAuthentication();
        if (!guarding) {
            LOG.warn("online-mode is on, so Mojang already checks who players are. Polaris login is not asking for passwords.");
        }
        heartbeat();
    }

    @SubscribeEvent
    public void onServerStopping(ServerStoppingEvent event) {
        held.clear();
        server = null;
    }

    @SubscribeEvent
    public void onServerTick(ServerTickEvent.Post event) {
        tick++;
        if (tick % HEARTBEAT_TICKS == 0) heartbeat();
        // A copy: a disconnect fires the logout event, which removes from the map.
        for (Map.Entry<UUID, Held> entry : new ArrayList<>(held.entrySet())) {
            ServerPlayer player = event.getServer().getPlayerList().getPlayer(entry.getKey());
            Held waiting = entry.getValue();
            if (player == null) {
                held.remove(entry.getKey());
            } else if (waiting.kick != null) {
                player.connection.disconnect(Component.literal(waiting.kick));
            } else if (tick > waiting.deadline && !waiting.busy) {
                player.connection.disconnect(Component.literal("You took too long to log in."));
            }
        }
    }

    private void heartbeat() {
        if (config.state() != PolarisConfig.State.ON || server == null) return;
        JsonObject body = new JsonObject();
        body.addProperty("mod", modVersion);
        body.addProperty("minecraft", server.getServerVersion());
        MinecraftServer current = server;
        client.call("hello", body).thenAccept(reply -> current.execute(() -> note(reply)));
    }

    /** Say in the log when Polaris stops or starts answering, once per change. */
    private void note(Reply reply) {
        if (!reply.reached()) {
            if (reachable) {
                LOG.error("Polaris cannot be reached at {} ({}). Nobody can log in until it can.",
                        config.baseUrl(), reply.unreachable());
            }
            reachable = false;
            return;
        }
        if (!reachable) LOG.info("Polaris is reachable again at {}.", config.baseUrl());
        reachable = true;
        boolean refused = reply.status() == 401;
        if (refused && linked) {
            LOG.error("Polaris refused this server's token. Nobody can log in until Polaris login is switched off and on again from the server's page.");
        } else if (!refused && !linked) {
            LOG.info("Polaris accepts this server's token again.");
        }
        linked = !refused;
    }

    // ------------------------------------------------------------------ joining

    @SubscribeEvent
    public void onJoin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!guarding || !(event.getEntity() instanceof ServerPlayer player)) return;
        Held waiting = new Held(player.position(), tick + LOGIN_TICKS);
        held.put(player.getUUID(), waiting);
        if (config.state() != PolarisConfig.State.ON) {
            waiting.kick = NOT_SET_UP;
            return;
        }
        tell(player, "Checking your account with Polaris...");
        waiting.busy = true;
        ask(player, waiting, "status", identity(player), (current, reply) -> {
            waiting.busy = false;
            if (!reply.reached()) {
                waiting.kick = UNREACHABLE;
            } else if (reply.status() == 401) {
                waiting.kick = UNLINKED;
            } else if (reply.status() != 200) {
                waiting.kick = "Polaris could not check your account (HTTP " + reply.status() + "). Try again in a minute.";
            } else {
                waiting.registered = reply.flag("registered");
                prompt(current, waiting);
            }
        });
    }

    @SubscribeEvent
    public void onLeave(PlayerEvent.PlayerLoggedOutEvent event) {
        held.remove(event.getEntity().getUUID());
    }

    private void prompt(ServerPlayer player, Held waiting) {
        long seconds = Math.max(0, (waiting.deadline - tick) / SECOND);
        if (Boolean.TRUE.equals(waiting.registered)) {
            tell(player, "Log in with /login <password>. You have " + seconds + " seconds.");
        } else {
            tell(player, "Choose a password for this server with /register <password> <password>. You have "
                    + seconds + " seconds. Put it in double quotes if it has spaces or symbols.");
        }
    }

    private void release(ServerPlayer player, String message) {
        held.remove(player.getUUID());
        player.sendSystemMessage(Component.literal(message).withStyle(ChatFormatting.GREEN));
    }

    // ------------------------------------------------------------------ commands

    @SubscribeEvent
    public void onRegisterCommands(RegisterCommandsEvent event) {
        CommandDispatcher<CommandSourceStack> commands = event.getDispatcher();
        commands.register(Commands.literal("register")
                .then(Commands.argument("password", StringArgumentType.string())
                        .then(Commands.argument("confirm", StringArgumentType.string())
                                .executes(context -> register(context.getSource().getPlayerOrException(),
                                        text(context, "password"), text(context, "confirm"))))));
        commands.register(Commands.literal("login")
                .then(Commands.argument("password", StringArgumentType.string())
                        .executes(context -> login(context.getSource().getPlayerOrException(),
                                text(context, "password")))));
        commands.register(Commands.literal("changepassword")
                .then(Commands.argument("current", StringArgumentType.string())
                        .then(Commands.argument("new", StringArgumentType.string())
                                .executes(context -> changePassword(context.getSource().getPlayerOrException(),
                                        text(context, "current"), text(context, "new"))))));
    }

    private static String text(CommandContext<CommandSourceStack> context, String name) {
        return StringArgumentType.getString(context, name);
    }

    private int register(ServerPlayer player, String password, String confirm) {
        Held waiting = waitingFor(player);
        if (waiting == null) return 0;
        if (Boolean.TRUE.equals(waiting.registered)) {
            tell(player, "You already have a password here. Log in with /login <password>.");
            return 0;
        }
        if (!password.equals(confirm)) {
            tell(player, "The two passwords are different. Type the same one twice.");
            return 0;
        }
        String problem = passwordProblem(password);
        if (problem != null) {
            tell(player, problem);
            return 0;
        }
        waiting.busy = true;
        JsonObject body = identity(player);
        body.addProperty("password", password);
        ask(player, waiting, "register", body, (current, reply) -> {
            waiting.busy = false;
            if (!reply.reached()) {
                tell(current, UNREACHABLE);
            } else if (reply.status() == 200) {
                release(current, "Password set. Welcome!");
            } else if (reply.status() == 409) {
                waiting.registered = true;
                tell(current, "You already have a password here. Log in with /login <password>.");
            } else {
                tell(current, failure(reply, "save your password"));
            }
        });
        return 1;
    }

    private int login(ServerPlayer player, String password) {
        Held waiting = waitingFor(player);
        if (waiting == null) return 0;
        waiting.busy = true;
        JsonObject body = identity(player);
        body.addProperty("password", password);
        ask(player, waiting, "login", body, (current, reply) -> {
            waiting.busy = false;
            if (!reply.reached()) {
                tell(current, UNREACHABLE);
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
        return 1;
    }

    private int changePassword(ServerPlayer player, String current, String next) {
        if (!guarding) {
            tell(player, "This server checks accounts with Mojang, so there is no password here.");
            return 0;
        }
        if (held.containsKey(player.getUUID())) {
            tell(player, "Log in first with /login <password>.");
            return 0;
        }
        String problem = passwordProblem(next);
        if (problem != null) {
            tell(player, problem);
            return 0;
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
                case 200 -> online.sendSystemMessage(Component.literal("Password changed.").withStyle(ChatFormatting.GREEN));
                case 403 -> tell(online, "Your current password is not that one.");
                case 429 -> tell(online, throttled(reply));
                default -> tell(online, failure(reply, "change your password"));
            }
        });
        return 1;
    }

    /** The held entry for a player about to log in, or null after telling them why not. */
    private Held waitingFor(ServerPlayer player) {
        if (!guarding) {
            tell(player, "This server checks accounts with Mojang, so there is no password here.");
            return null;
        }
        Held waiting = held.get(player.getUUID());
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

    private static JsonObject identity(ServerPlayer player) {
        JsonObject body = new JsonObject();
        body.addProperty("player", player.getGameProfile().getName());
        return body;
    }

    /**
     * Ask Polaris, and handle the answer on the server thread - but only if the
     * player is still online and, when {@code waiting} is given, still the same
     * wait. A player who left and came back has a new one, and an answer to the
     * old one must not log them in.
     */
    private void ask(ServerPlayer player, Held waiting, String action, JsonObject body,
            BiConsumer<ServerPlayer, Reply> then) {
        MinecraftServer current = server;
        if (current == null) return;
        UUID id = player.getUUID();
        client.call(action, body).thenAccept(reply -> current.execute(() -> {
            note(reply);
            ServerPlayer online = current.getPlayerList().getPlayer(id);
            if (online == null || (waiting != null && held.get(id) != waiting)) return;
            then.accept(online, reply);
        }));
    }

    private static void tell(ServerPlayer player, String message) {
        player.sendSystemMessage(Component.literal(message).withStyle(ChatFormatting.GOLD));
    }

    // ------------------------------------------------------------------ holding

    private boolean isHeld(Entity entity) {
        return entity instanceof ServerPlayer player && held.containsKey(player.getUUID());
    }

    /** Remind a held player what to do, at most every few seconds. */
    private void remind(ServerPlayer player) {
        Held waiting = held.get(player.getUUID());
        if (waiting == null || waiting.busy || tick - waiting.remindedAt < REMINDER_TICKS) return;
        waiting.remindedAt = tick;
        if (waiting.registered != null) prompt(player, waiting);
    }

    @SubscribeEvent
    public void onPlayerTick(PlayerTickEvent.Post event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        Held waiting = held.get(player.getUUID());
        if (waiting == null) return;
        player.resetFallDistance();
        if (player.position().distanceToSqr(waiting.anchor) > 0.01) {
            player.connection.teleport(waiting.anchor.x, waiting.anchor.y, waiting.anchor.z,
                    player.getYRot(), player.getXRot());
        }
    }

    @SubscribeEvent
    public void onChat(ServerChatEvent event) {
        if (!isHeld(event.getPlayer())) return;
        event.setCanceled(true);
        remind(event.getPlayer());
    }

    @SubscribeEvent
    public void onCommand(CommandEvent event) {
        ServerPlayer player = event.getParseResults().getContext().getSource().getPlayer();
        if (player == null || !held.containsKey(player.getUUID())) return;
        String input = event.getParseResults().getReader().getString().trim();
        if (input.startsWith("/")) input = input.substring(1);
        int space = input.indexOf(' ');
        String root = (space < 0 ? input : input.substring(0, space)).toLowerCase(Locale.ROOT);
        if (OPEN_COMMANDS.contains(root)) return;
        event.setCanceled(true);
        remind(player);
    }

    @SubscribeEvent
    public void onBreak(BlockEvent.BreakEvent event) {
        if (isHeld(event.getPlayer())) event.setCanceled(true);
    }

    @SubscribeEvent
    public void onPlace(BlockEvent.EntityPlaceEvent event) {
        if (isHeld(event.getEntity())) event.setCanceled(true);
    }

    @SubscribeEvent
    public void onUseBlock(PlayerInteractEvent.RightClickBlock event) {
        if (isHeld(event.getEntity())) event.setCanceled(true);
    }

    @SubscribeEvent
    public void onUseItem(PlayerInteractEvent.RightClickItem event) {
        if (isHeld(event.getEntity())) event.setCanceled(true);
    }

    @SubscribeEvent
    public void onHitBlock(PlayerInteractEvent.LeftClickBlock event) {
        if (isHeld(event.getEntity())) event.setCanceled(true);
    }

    @SubscribeEvent
    public void onUseEntity(PlayerInteractEvent.EntityInteract event) {
        if (isHeld(event.getEntity())) event.setCanceled(true);
    }

    @SubscribeEvent
    public void onUseEntityAt(PlayerInteractEvent.EntityInteractSpecific event) {
        if (isHeld(event.getEntity())) event.setCanceled(true);
    }

    @SubscribeEvent
    public void onAttack(AttackEntityEvent event) {
        if (isHeld(event.getEntity())) event.setCanceled(true);
    }

    @SubscribeEvent
    public void onHurt(LivingIncomingDamageEvent event) {
        if (isHeld(event.getEntity())) event.setCanceled(true);
    }

    /** A cancelled toss destroys the stack it was about, since it has already left
     *  the inventory - so it is put back. */
    @SubscribeEvent
    public void onToss(ItemTossEvent event) {
        if (!isHeld(event.getPlayer())) return;
        event.setCanceled(true);
        event.getPlayer().getInventory().add(event.getEntity().getItem().copy());
    }

    @SubscribeEvent
    public void onPickup(ItemEntityPickupEvent.Pre event) {
        if (isHeld(event.getPlayer())) event.setCanPickup(TriState.FALSE);
    }
}
