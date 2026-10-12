package polaris.minecraft;

import it.unimi.dsi.fastutil.ints.IntList;
import java.util.ArrayDeque;
import java.util.List;
import java.util.function.Function;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitlesAnimationPacket;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.projectile.FireworkRocketEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.FireworkExplosion;
import net.minecraft.world.item.component.Fireworks;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.Heightmap;

/**
 * The two midnights: Christmas Eve's (fireworks, a message and a gift for
 * everybody online) and New Year's (the last ten seconds counted down on every
 * screen, then fireworks around each player, a title and a small gift, with
 * sparkles through the last hour if they are on).
 *
 * The moments are instants the dashboard worked out on the server's clock
 * ({@link WinterPlan#eveAt}, {@link WinterPlan#newYearAt}); this only compares
 * them with the time. A midnight celebrated is written to the store before
 * anybody is given anything, so a restart in the minute after never gives twice.
 *
 * The fireworks are bounded: a few per player, never more than
 * {@link #MAX_ROCKETS} for the whole server, launched a few per tick away from
 * where anybody stands so none goes off in a face.
 *
 * Server thread only.
 */
final class SeasonalNewYear {
    private static final int ROCKETS_PER_PLAYER = 8;
    private static final int MAX_ROCKETS = 96;
    private static final int LAUNCH_PER_TICK = 4;
    /** Spread over this many ticks, and this far from the player. */
    private static final int SHOW_TICKS = 160;
    private static final int MIN_DISTANCE = 6;
    private static final int MAX_DISTANCE = 14;
    private static final int SPARKLE_TICKS = 20;

    private static final int[] COLOURS = {0xE53935, 0x43A047, 0xFDD835, 0x1E88E5, 0xFFFFFF, 0xFB8C00, 0x8E24AA};

    private record Launch(ResourceKey<Level> dimension, double x, double y, double z, long due) {}

    private static final ArrayDeque<Launch> launches = new ArrayDeque<>();
    private static int shown;
    private static long ticks;

    static void forget() {
        launches.clear();
        shown = 0;
    }

    static void tick(MinecraftServer server) {
        ticks++;
        WinterPlan plan = SeasonalWinter.plan();
        long now = System.currentTimeMillis();
        if (plan.newYear()) {
            int second = WinterPlan.countdown(now, plan.newYearAt());
            if (second > 0 && second != shown) {
                shown = second;
                if (second == WinterPlan.COUNTDOWN_SECONDS) {
                    broadcast(server, player -> words(plan, player, WinterPlan.Line.NEW_YEAR_SOON).withStyle(ChatFormatting.GOLD));
                }
                Component count = Component.literal(Integer.toString(second)).withStyle(ChatFormatting.GOLD, ChatFormatting.BOLD);
                title(server, player -> count, null);
            } else if (second == 0) {
                shown = 0;
            }
            if (WinterPlan.celebrating(now, plan.newYearAt()) && once(server, SeasonalWinterStore.NEW_YEAR_DONE, plan.newYearAt())) {
                title(server, player -> words(plan, player, WinterPlan.Line.NEW_YEAR).withStyle(ChatFormatting.GOLD, ChatFormatting.BOLD),
                        player -> words(plan, player, WinterPlan.Line.NEW_YEAR_GIFT).withStyle(ChatFormatting.YELLOW));
                broadcast(server, player -> words(plan, player, WinterPlan.Line.NEW_YEAR_ALL).withStyle(ChatFormatting.GOLD));
                show(server);
                gift(server, rockets(4), new ItemStack(Items.COOKIE, 4));
            }
            if (plan.sparkles() && WinterPlan.lastHour(now, plan.newYearAt()) && ticks % SPARKLE_TICKS == 0) sparkle(server);
        }
        if (plan.eve() && WinterPlan.celebrating(now, plan.eveAt()) && once(server, SeasonalWinterStore.EVE_DONE, plan.eveAt())) {
            title(server, player -> words(plan, player, WinterPlan.Line.CHRISTMAS).withStyle(ChatFormatting.RED, ChatFormatting.BOLD),
                    player -> words(plan, player, WinterPlan.Line.CHRISTMAS_GIFT).withStyle(ChatFormatting.GREEN));
            broadcast(server, player -> words(plan, player, WinterPlan.Line.CHRISTMAS_ALL).withStyle(ChatFormatting.RED));
            show(server);
            gift(server, new ItemStack(Items.CAKE), new ItemStack(Items.COOKIE, 8));
        }
        launch(server);
    }

    /** Whether this midnight is the first time here; written down before it is celebrated. */
    private static boolean once(MinecraftServer server, String key, long midnight) {
        if (SeasonalWinterStore.data(server).getLong(key) == midnight) return false;
        SeasonalWinterStore.data(server).putLong(key, midnight);
        SeasonalWinterStore.save(server);
        return true;
    }

    /** Rockets that burst in the season's colours. */
    static ItemStack rockets(int count) {
        ItemStack stack = new ItemStack(Items.FIREWORK_ROCKET, count);
        FireworkExplosion burst = new FireworkExplosion(FireworkExplosion.Shape.LARGE_BALL,
                IntList.of(0xE53935, 0x43A047, 0xFDD835), IntList.of(0xFFFFFF), true, true);
        stack.set(DataComponents.FIREWORKS, new Fireworks(2, List.of(burst)));
        return stack;
    }

    /** A line for one player, in their client's language. */
    private static MutableComponent words(WinterPlan plan, ServerPlayer player, WinterPlan.Line line) {
        return Component.literal(plan.words(line, player.clientInformation().language()));
    }

    /** Every player online gets the message made for them, so each reads their own language. */
    private static void broadcast(MinecraftServer server, Function<ServerPlayer, Component> message) {
        for (ServerPlayer player : server.getPlayerList().getPlayers()) player.sendSystemMessage(message.apply(player));
    }

    private static void title(MinecraftServer server, Function<ServerPlayer, Component> title, Function<ServerPlayer, Component> subtitle) {
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            player.connection.send(new ClientboundSetTitlesAnimationPacket(0, 30, 10));
            if (subtitle != null) player.connection.send(new ClientboundSetSubtitleTextPacket(subtitle.apply(player)));
            player.connection.send(new ClientboundSetTitleTextPacket(title.apply(player)));
        }
    }

    private static void gift(MinecraftServer server, ItemStack... items) {
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            for (ItemStack item : items) {
                ItemStack given = item.copy();
                player.getInventory().add(given);
                if (!given.isEmpty()) player.drop(given, false);
            }
        }
    }

    /** A few rockets around every player, queued over a few seconds. */
    private static void show(MinecraftServer server) {
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            if (player.isSpectator()) continue;
            ServerLevel level = player.serverLevel();
            RandomSource random = level.random;
            for (int i = 0; i < ROCKETS_PER_PLAYER && launches.size() < MAX_ROCKETS; i++) {
                double angle = random.nextDouble() * Math.PI * 2;
                int distance = MIN_DISTANCE + random.nextInt(MAX_DISTANCE - MIN_DISTANCE + 1);
                int x = (int) Math.floor(player.getX() + Math.cos(angle) * distance);
                int z = (int) Math.floor(player.getZ() + Math.sin(angle) * distance);
                if (!level.hasChunk(x >> 4, z >> 4)) continue;
                int y = level.getHeight(Heightmap.Types.MOTION_BLOCKING, x, z);
                // Under a roof, or deep in a cave: from just above the player instead.
                if (y > player.getBlockY() + 24) y = player.getBlockY() + 2;
                launches.add(new Launch(level.dimension(), x + 0.5, y + 0.5, z + 0.5, ticks + random.nextInt(SHOW_TICKS)));
            }
        }
    }

    private static void launch(MinecraftServer server) {
        if (launches.isEmpty()) return;
        int launched = 0;
        int left = launches.size();
        while (left-- > 0 && launched < LAUNCH_PER_TICK) {
            Launch next = launches.removeFirst();
            if (next.due() > ticks) {
                launches.addLast(next);
                continue;
            }
            ServerLevel level = server.getLevel(next.dimension());
            BlockPos at = BlockPos.containing(next.x(), next.y(), next.z());
            if (level == null || !level.hasChunk(at.getX() >> 4, at.getZ() >> 4)) continue;
            ItemStack stack = new ItemStack(Items.FIREWORK_ROCKET);
            RandomSource random = level.random;
            FireworkExplosion burst = new FireworkExplosion(
                    FireworkExplosion.Shape.values()[random.nextInt(FireworkExplosion.Shape.values().length)],
                    IntList.of(COLOURS[random.nextInt(COLOURS.length)], COLOURS[random.nextInt(COLOURS.length)]),
                    IntList.of(COLOURS[random.nextInt(COLOURS.length)]), random.nextBoolean(), random.nextBoolean());
            stack.set(DataComponents.FIREWORKS, new Fireworks(1 + random.nextInt(2), List.of(burst)));
            level.addFreshEntity(new FireworkRocketEntity(level, next.x(), next.y(), next.z(), stack));
            launched++;
        }
    }

    private static void sparkle(MinecraftServer server) {
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            if (player.isSpectator()) continue;
            player.serverLevel().sendParticles(player, ParticleTypes.FIREWORK, false, false,
                    player.getX(), player.getY() + 1.5, player.getZ(), 6, 1.5, 1.0, 1.5, 0.02);
        }
    }
}
