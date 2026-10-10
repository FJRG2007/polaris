package polaris.minecraft;

import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.DoubleArgumentType;
import com.mojang.brigadier.arguments.FloatArgumentType;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import java.util.function.Function;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.ResourceLocationArgument;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.entity.player.PlayerRespawnPositionEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

/**
 * The commands the dashboard runs events with, for the console and operators
 * only (permission level 4). Every one answers a single line of JSON.
 *
 * - {@code polaris caps}: this mod's version and what it can do, so the
 *   dashboard uses a command only where the server has it.
 * - {@code polaris stash save|restore <player> <key>} ({@link EventStash}).
 * - {@code polaris batch run <key> [blocksPerTick]}, {@code status},
 *   {@code cancel} ({@link EventBatch}).
 *
 * - {@code polaris respawn set <key> <player> <dimension> <x> <y> <z> <yaw>},
 *   {@code list <key>}, {@code clear <key>} ({@link EventRespawn}).
 * - {@code polaris sounds status|refresh} ({@link SoundPack}).
 *
 * Hide and seek ({@link EventSeek}) needs no command: it follows the tags.
 */
final class EventCommands {
    /** What `polaris caps` lists; the dashboard checks each by name. */
    static final String[] CAPS = {"stash", "batch", "seek", "respawn"};

    private final String version;

    EventCommands(String version) {
        this.version = version;
    }

    @SubscribeEvent
    public void onRegister(RegisterCommandsEvent event) {
        event.getDispatcher().register(Commands.literal("polaris")
                .requires(source -> source.hasPermission(Commands.LEVEL_OWNERS))
                .then(Commands.literal("caps").executes(context -> answer(context, server -> caps())))
                .then(Commands.literal("capabilities").executes(context -> answer(context, server -> caps())))
                .then(Commands.literal("sounds")
                        .then(Commands.literal("status").executes(context -> answer(context, server -> sounds(server, false))))
                        .then(Commands.literal("refresh").executes(context -> answer(context, server -> sounds(server, true)))))
                .then(Commands.literal("stash")
                        .then(Commands.literal("save").then(playerAndKey(EventStash::save)))
                        .then(Commands.literal("restore").then(playerAndKey(EventStash::restore))))
                .then(Commands.literal("respawn")
                        .then(Commands.literal("set").then(Commands.argument("key", StringArgumentType.word())
                                .then(Commands.argument("player", StringArgumentType.word())
                                        .then(Commands.argument("dimension", ResourceLocationArgument.id())
                                                .then(Commands.argument("x", DoubleArgumentType.doubleArg(-3.0E7, 3.0E7))
                                                        .then(Commands.argument("y", DoubleArgumentType.doubleArg(-2048, 2048))
                                                                .then(Commands.argument("z", DoubleArgumentType.doubleArg(-3.0E7, 3.0E7))
                                                                        .then(Commands.argument("yaw", FloatArgumentType.floatArg(-360, 360))
                                                                                .executes(context -> answer(context, server -> EventRespawn.set(
                                                                                        server, key(context),
                                                                                        StringArgumentType.getString(context, "player"),
                                                                                        ResourceLocationArgument.getId(context, "dimension"),
                                                                                        DoubleArgumentType.getDouble(context, "x"),
                                                                                        DoubleArgumentType.getDouble(context, "y"),
                                                                                        DoubleArgumentType.getDouble(context, "z"),
                                                                                        FloatArgumentType.getFloat(context, "yaw")))))))))))
                        .then(Commands.literal("list").then(Commands.argument("key", StringArgumentType.word())
                                .executes(context -> answer(context, server -> EventRespawn.list(key(context))))))
                        .then(Commands.literal("clear").then(Commands.argument("key", StringArgumentType.word())
                                .executes(context -> answer(context, server -> EventRespawn.clear(key(context)))))))
                .then(Commands.literal("batch")
                        .then(Commands.literal("run").then(Commands.argument("key", StringArgumentType.word())
                                .executes(context -> answer(context, server -> EventBatch.run(
                                        server, key(context), EventBatch.DEFAULT_BLOCKS_PER_TICK)))
                                .then(Commands.argument("blocksPerTick", IntegerArgumentType.integer(1, 1_000_000))
                                        .executes(context -> answer(context, server -> EventBatch.run(
                                                server, key(context),
                                                IntegerArgumentType.getInteger(context, "blocksPerTick")))))))
                        .then(Commands.literal("status").then(Commands.argument("key", StringArgumentType.word())
                                .executes(context -> answer(context, server -> EventBatch.status(server, key(context))))))
                        .then(Commands.literal("cancel").then(Commands.argument("key", StringArgumentType.word())
                                .executes(context -> answer(context, server -> EventBatch.cancel(server, key(context))))))));
    }

    @FunctionalInterface
    private interface PlayerAction {
        JsonObject apply(MinecraftServer server, String player, String key);
    }

    private static com.mojang.brigadier.builder.RequiredArgumentBuilder<CommandSourceStack, String> playerAndKey(
            PlayerAction action) {
        return Commands.argument("player", StringArgumentType.word())
                .then(Commands.argument("key", StringArgumentType.word())
                        .executes(context -> answer(context, server -> action.apply(
                                server, StringArgumentType.getString(context, "player"), key(context)))));
    }

    private static String key(CommandContext<CommandSourceStack> context) {
        return StringArgumentType.getString(context, "key");
    }

    /** Runs a command and says its JSON; a key that is not one is answered, not run. */
    private static int answer(
            CommandContext<CommandSourceStack> context, Function<MinecraftServer, JsonObject> work) {
        JsonObject reply;
        boolean keyed = context.getNodes().stream().anyMatch(node -> node.getNode().getName().equals("key"));
        if (keyed && !EventStash.validKey(key(context))) {
            reply = new JsonObject();
            reply.addProperty("ok", false);
            reply.addProperty("why", "badKey");
        } else {
            try {
                reply = work.apply(context.getSource().getServer());
            } catch (RuntimeException failed) {
                PolarisMod.LOG.error("A Polaris event command failed", failed);
                reply = new JsonObject();
                reply.addProperty("ok", false);
                reply.addProperty("why", "error");
            }
        }
        String line = reply.toString();
        context.getSource().sendSuccess(() -> Component.literal(line), false);
        return reply.has("ok") && reply.get("ok").getAsBoolean() ? 1 : 0;
    }

    /** {@code polaris sounds status|refresh} ({@link SoundPack}); not ok where
     *  the server's sounds are off or it does not know where Polaris is. */
    private static JsonObject sounds(MinecraftServer server, boolean refresh) {
        SoundPack pack = SoundPack.instance();
        if (pack == null) {
            JsonObject reply = new JsonObject();
            reply.addProperty("ok", false);
            reply.addProperty("why", "off");
            return reply;
        }
        return refresh ? pack.refreshNow(server) : pack.status(server);
    }

    private JsonObject caps() {
        // `polaris capabilities` and `polaris caps` answer the same.
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("polaris", version);
        com.google.gson.JsonArray caps = new com.google.gson.JsonArray();
        for (String cap : CAPS) if (!cap.equals("seek") || (EventSeek.available() && !seekBroken)) caps.add(cap);
        reply.add("caps", caps);
        return reply;
    }

    /** Off for good once it has thrown: a tick must never fail over it. */
    private boolean seekBroken;

    @SubscribeEvent
    public void onTick(ServerTickEvent.Post event) {
        try {
            EventBatch.tick(event.getServer());
        } catch (RuntimeException failed) {
            PolarisMod.LOG.error("A Polaris batch failed this tick", failed);
        }
        if (seekBroken) return;
        try {
            EventSeek.tick(event.getServer());
        } catch (RuntimeException failed) {
            seekBroken = true;
            PolarisMod.LOG.error("Polaris hide and seek failed and is off until the server restarts", failed);
            try {
                EventSeek.giveUp(event.getServer());
            } catch (RuntimeException ignored) {
                // Nothing more to do: the tick goes on.
            }
        }
    }

    /** Last, so the event's spot is the one the player respawns at. */
    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onRespawnPosition(PlayerRespawnPositionEvent event) {
        try {
            EventRespawn.respawning(event);
        } catch (RuntimeException failed) {
            PolarisMod.LOG.error("A Polaris event respawn failed; the player respawns where the game chose", failed);
        }
    }

    @SubscribeEvent
    public void onLeave(PlayerEvent.PlayerLoggedOutEvent event) {
        EventRespawn.left(event.getEntity().getUUID());
    }

    @SubscribeEvent
    public void onPlayerSaved(PlayerEvent.SaveToFile event) {
        EventStash.playerSaved(event.getEntity().getUUID());
    }
}
