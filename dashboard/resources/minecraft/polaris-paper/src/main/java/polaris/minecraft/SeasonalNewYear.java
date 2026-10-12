package polaris.minecraft;

import java.util.ArrayDeque;
import java.util.Map;
import java.util.Random;
import java.util.function.Function;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Color;
import org.bukkit.FireworkEffect;
import org.bukkit.GameMode;
import org.bukkit.HeightMap;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Particle;
import org.bukkit.World;
import org.bukkit.entity.Firework;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.FireworkMeta;

/**
 * The two midnights: Christmas Eve's (fireworks, a message and a gift for
 * everybody online) and New Year's (the last ten seconds counted down on every
 * screen, then fireworks around each player, a title and a small gift, with
 * sparkles through the last hour if they are on). The same as the NeoForge mod's.
 *
 * The moments are instants the dashboard worked out on the server's clock
 * ({@link WinterPlan#eveAt}, {@link WinterPlan#newYearAt}); this only compares
 * them with the time. A midnight celebrated is written to the store before
 * anybody is given anything, so a restart in the minute after never gives twice.
 *
 * The fireworks are bounded: a few per player, never more than
 * {@link #MAX_ROCKETS} for the whole server, launched a few per tick away from
 * where anybody stands so none goes off in a face.
 */
final class SeasonalNewYear {
    private static final int ROCKETS_PER_PLAYER = 8;
    private static final int MAX_ROCKETS = 96;
    private static final int LAUNCH_PER_TICK = 4;
    private static final int SHOW_TICKS = 160;
    private static final int MIN_DISTANCE = 6;
    private static final int MAX_DISTANCE = 14;
    private static final int SPARKLE_TICKS = 20;

    private static final int[] COLOURS = {0xE53935, 0x43A047, 0xFDD835, 0x1E88E5, 0xFFFFFF, 0xFB8C00, 0x8E24AA};

    private record Launch(Location at, long due) {}

    private final SeasonalWinterStore store;
    private final Random random = new Random();
    private final ArrayDeque<Launch> launches = new ArrayDeque<>();
    private int shown;
    private long ticks;

    SeasonalNewYear(SeasonalWinterStore store) {
        this.store = store;
    }

    void forget() {
        launches.clear();
        shown = 0;
    }

    void tick() {
        ticks++;
        WinterPlan plan = SeasonalWinter.plan();
        long now = System.currentTimeMillis();
        if (plan.newYear()) {
            int second = WinterPlan.countdown(now, plan.newYearAt());
            if (second > 0 && second != shown) {
                shown = second;
                if (second == WinterPlan.COUNTDOWN_SECONDS) broadcast(player -> ChatColor.GOLD + words(plan, player, WinterPlan.Line.NEW_YEAR_SOON));
                String count = ChatColor.GOLD + "" + ChatColor.BOLD + second;
                title(player -> count, player -> "");
            } else if (second == 0) {
                shown = 0;
            }
            if (WinterPlan.celebrating(now, plan.newYearAt()) && once(SeasonalWinterStore.NEW_YEAR_DONE, plan.newYearAt())) {
                title(player -> ChatColor.GOLD + "" + ChatColor.BOLD + words(plan, player, WinterPlan.Line.NEW_YEAR),
                        player -> ChatColor.YELLOW + words(plan, player, WinterPlan.Line.NEW_YEAR_GIFT));
                broadcast(player -> ChatColor.GOLD + words(plan, player, WinterPlan.Line.NEW_YEAR_ALL));
                show();
                gift(rockets(4), new ItemStack(Material.COOKIE, 4));
            }
            if (plan.sparkles() && WinterPlan.lastHour(now, plan.newYearAt()) && ticks % SPARKLE_TICKS == 0) sparkle();
        }
        if (plan.eve() && WinterPlan.celebrating(now, plan.eveAt()) && once(SeasonalWinterStore.EVE_DONE, plan.eveAt())) {
            title(player -> ChatColor.RED + "" + ChatColor.BOLD + words(plan, player, WinterPlan.Line.CHRISTMAS),
                    player -> ChatColor.GREEN + words(plan, player, WinterPlan.Line.CHRISTMAS_GIFT));
            broadcast(player -> ChatColor.RED + words(plan, player, WinterPlan.Line.CHRISTMAS_ALL));
            show();
            gift(new ItemStack(Material.CAKE), new ItemStack(Material.COOKIE, 8));
        }
        launch();
    }

    /** Whether this midnight is the first time here; written down before it is celebrated. */
    private boolean once(String key, long midnight) {
        if (store.data().getLong(key) == midnight) return false;
        store.data().set(key, midnight);
        store.save();
        return true;
    }

    /** Rockets that burst in the season's colours. */
    static ItemStack rockets(int count) {
        ItemStack stack = new ItemStack(Material.FIREWORK_ROCKET, count);
        if (stack.getItemMeta() instanceof FireworkMeta meta) {
            meta.addEffect(FireworkEffect.builder().with(FireworkEffect.Type.BALL_LARGE)
                    .withColor(Color.fromRGB(0xE53935), Color.fromRGB(0x43A047), Color.fromRGB(0xFDD835))
                    .withFade(Color.WHITE).trail(true).flicker(true).build());
            meta.setPower(2);
            stack.setItemMeta(meta);
        }
        return stack;
    }

    /** A line for one player, in their client's language. */
    private static String words(WinterPlan plan, Player player, WinterPlan.Line line) {
        return plan.words(line, player.getLocale());
    }

    /** Every player online gets the message made for them, so each reads their own language. */
    private static void broadcast(Function<Player, String> message) {
        for (Player player : Bukkit.getOnlinePlayers()) player.sendMessage(message.apply(player));
    }

    private static void title(Function<Player, String> title, Function<Player, String> subtitle) {
        for (Player player : Bukkit.getOnlinePlayers()) player.sendTitle(title.apply(player), subtitle.apply(player), 0, 30, 10);
    }

    private static void gift(ItemStack... items) {
        for (Player player : Bukkit.getOnlinePlayers()) {
            for (ItemStack item : items) {
                Map<Integer, ItemStack> left = player.getInventory().addItem(item.clone());
                for (ItemStack rest : left.values()) player.getWorld().dropItemNaturally(player.getLocation(), rest);
            }
        }
    }

    /** A few rockets around every player, queued over a few seconds. */
    private void show() {
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (player.getGameMode() == GameMode.SPECTATOR) continue;
            World world = player.getWorld();
            Location at = player.getLocation();
            for (int i = 0; i < ROCKETS_PER_PLAYER && launches.size() < MAX_ROCKETS; i++) {
                double angle = random.nextDouble() * Math.PI * 2;
                int distance = MIN_DISTANCE + random.nextInt(MAX_DISTANCE - MIN_DISTANCE + 1);
                int x = (int) Math.floor(at.getX() + Math.cos(angle) * distance);
                int z = (int) Math.floor(at.getZ() + Math.sin(angle) * distance);
                if (!world.isChunkLoaded(x >> 4, z >> 4)) continue;
                int y = world.getHighestBlockYAt(x, z, HeightMap.MOTION_BLOCKING) + 1;
                // Under a roof, or deep in a cave: from just above the player instead.
                if (y > at.getBlockY() + 24) y = at.getBlockY() + 2;
                launches.add(new Launch(new Location(world, x + 0.5, y + 0.5, z + 0.5), ticks + random.nextInt(SHOW_TICKS)));
            }
        }
    }

    private void launch() {
        if (launches.isEmpty()) return;
        int launched = 0;
        int left = launches.size();
        while (left-- > 0 && launched < LAUNCH_PER_TICK) {
            Launch next = launches.removeFirst();
            if (next.due() > ticks) {
                launches.addLast(next);
                continue;
            }
            World world = next.at().getWorld();
            if (world == null || !world.isChunkLoaded(next.at().getBlockX() >> 4, next.at().getBlockZ() >> 4)) continue;
            FireworkEffect.Type[] shapes = FireworkEffect.Type.values();
            FireworkEffect effect = FireworkEffect.builder().with(shapes[random.nextInt(shapes.length)])
                    .withColor(Color.fromRGB(COLOURS[random.nextInt(COLOURS.length)]), Color.fromRGB(COLOURS[random.nextInt(COLOURS.length)]))
                    .withFade(Color.fromRGB(COLOURS[random.nextInt(COLOURS.length)]))
                    .trail(random.nextBoolean()).flicker(random.nextBoolean()).build();
            int power = 1 + random.nextInt(2);
            world.spawn(next.at(), Firework.class, firework -> {
                FireworkMeta meta = firework.getFireworkMeta();
                meta.addEffect(effect);
                meta.setPower(power);
                firework.setFireworkMeta(meta);
            });
            launched++;
        }
    }

    private static void sparkle() {
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (player.getGameMode() == GameMode.SPECTATOR) continue;
            Location at = player.getLocation();
            player.spawnParticle(Particle.FIREWORK, at.getX(), at.getY() + 1.5, at.getZ(), 6, 1.5, 1.0, 1.5, 0.02);
        }
    }
}
