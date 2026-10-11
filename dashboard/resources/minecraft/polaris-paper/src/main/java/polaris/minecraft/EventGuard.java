package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.entity.AreaEffectCloud;
import org.bukkit.entity.Entity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.entity.TNTPrimed;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockBurnEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.block.BlockFromToEvent;
import org.bukkit.event.block.BlockIgniteEvent;
import org.bukkit.event.block.BlockPistonExtendEvent;
import org.bukkit.event.block.BlockPistonRetractEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.block.BlockSpreadEvent;
import org.bukkit.event.entity.AreaEffectCloudApplyEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.entity.PotionSplashEvent;
import org.bukkit.event.entity.ProjectileHitEvent;
import org.bukkit.event.player.PlayerBucketEmptyEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.projectiles.ProjectileSource;

/**
 * Nobody outside an event can change it, as the NeoForge mod's
 * {@code EventGuard} keeps it there.
 *
 * {@code polaris guard set <key> <x1> <y1> <z1> <x2> <y2> <z2>} marks a box in
 * the Overworld as an event's space while the event under {@code key} lasts;
 * {@code polaris guard clear <key>} lets it go, and a box not set again for
 * {@link #KEPT_MS} lets itself go. Who takes part is told by the tags the
 * dashboard puts on everybody it takes in ({@link #ENTRANT_TAGS}). Anybody else -
 * operators and creative players included - cannot break, place or use a block
 * in the box, use anything in it, hit, shoot or splash anybody taking part, pour
 * or light anything over it, or ride into it; an explosion from outside leaves
 * its blocks and its players alone, and no piston, fluid or fire from outside
 * reaches into it.
 *
 * Commands and events both run on the main thread.
 */
final class EventGuard implements Listener {
    /** Kept in step with `IN_ARENA` in `kinds/arena.ts` and `kinds/stage.ts`. */
    static final String[] ENTRANT_TAGS = {"pe_arena", "pe_in"};
    /** How long a box stands without being set again. */
    static final long KEPT_MS = 10 * 60_000L;
    /** Blocks round a box over which pouring or lighting is refused, at any height. */
    private static final int POUR_MARGIN = 8;
    /** Blocks round a box a splash reaches into it from. */
    private static final double SPLASH = 4.5;
    /** As the NeoForge mod's keys (`EventStash.KEY`). */
    private static final Pattern KEY = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final int FAR = 30_000_000;

    /** Corners included: the far edge one block past the last one. */
    private record Box(double minX, double minY, double minZ, double maxX, double maxY, double maxZ) {
        boolean contains(double x, double y, double z, double grow) {
            return x >= minX - grow && x < maxX + grow
                    && y >= minY - grow && y < maxY + grow
                    && z >= minZ - grow && z < maxZ + grow;
        }
    }

    private record Guard(String key, Box box, long until) {}

    private final Map<String, Guard> guards = new ConcurrentHashMap<>();

    EventGuard(JavaPlugin plugin) {
        // Twice a second: nobody outside rides into a box.
        plugin.getServer().getScheduler().runTaskTimer(plugin, this::dismountOutsiders, 10L, 10L);
    }

    /** {@code polaris guard ...}, its arguments after {@code guard}. */
    JsonObject answer(String[] args) {
        if (args.length == 1 && args[0].equalsIgnoreCase("list")) return list();
        if (args.length == 2 && args[0].equalsIgnoreCase("clear")) {
            if (!KEY.matcher(args[1]).matches()) return SoundPack.refused("badKey");
            return clear(args[1]);
        }
        if (args.length == 8 && args[0].equalsIgnoreCase("set")) {
            if (!KEY.matcher(args[1]).matches()) return SoundPack.refused("badKey");
            try {
                int[] at = new int[6];
                for (int i = 0; i < 6; i++) {
                    at[i] = Integer.parseInt(args[i + 2]);
                    if (Math.abs(at[i]) > FAR) return SoundPack.refused("usage");
                }
                return set(args[1], at);
            } catch (NumberFormatException bad) {
                return SoundPack.refused("usage");
            }
        }
        return SoundPack.refused("usage");
    }

    private JsonObject set(String key, int[] at) {
        Box box = new Box(
                Math.min(at[0], at[3]), Math.min(at[1], at[4]), Math.min(at[2], at[5]),
                Math.max(at[0], at[3]) + 1, Math.max(at[1], at[4]) + 1, Math.max(at[2], at[5]) + 1);
        guards.put(key, new Guard(key, box, System.currentTimeMillis() + KEPT_MS));
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        return reply;
    }

    private JsonObject clear(String key) {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("cleared", guards.remove(key) != null ? 1 : 0);
        return reply;
    }

    private JsonObject list() {
        JsonArray keys = new JsonArray();
        for (Guard guard : live()) keys.add(guard.key());
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.add("keys", keys);
        return reply;
    }

    private Iterable<Guard> live() {
        long now = System.currentTimeMillis();
        guards.values().removeIf(guard -> guard.until() < now);
        return guards.values();
    }

    /** Taking part: carries an event's tag. */
    static boolean entrant(Entity entity) {
        if (entity == null) return false;
        for (String tag : ENTRANT_TAGS) if (entity.getScoreboardTags().contains(tag)) return true;
        return false;
    }

    /** Somebody who may not touch an event: a player not taking part, spectators aside. */
    private static boolean outsider(Object who) {
        return who instanceof Player player && player.getGameMode() != GameMode.SPECTATOR && !entrant(player);
    }

    private static boolean overworld(World world) {
        List<World> worlds = Bukkit.getWorlds();
        return world != null && !worlds.isEmpty() && worlds.get(0).equals(world);
    }

    private boolean inside(Location at, double grow) {
        if (guards.isEmpty() || at == null || !overworld(at.getWorld())) return false;
        for (Guard guard : live()) if (guard.box().contains(at.getX(), at.getY(), at.getZ(), grow)) return true;
        return false;
    }

    private boolean inside(Block block) {
        return block != null && inside(block.getLocation().add(0.5, 0.5, 0.5), 0);
    }

    /** Over a box or beside it, at any height: where a fluid poured or a fire lit runs into it. */
    private boolean over(Location at) {
        if (guards.isEmpty() || at == null || !overworld(at.getWorld())) return false;
        for (Guard guard : live()) {
            Box box = guard.box();
            if (at.getX() >= box.minX() - POUR_MARGIN && at.getX() < box.maxX() + POUR_MARGIN
                    && at.getZ() >= box.minZ() - POUR_MARGIN && at.getZ() < box.maxZ() + POUR_MARGIN)
                return true;
        }
        return false;
    }

    private static boolean pours(ItemStack stack) {
        if (stack == null) return false;
        Material type = stack.getType();
        return type == Material.FLINT_AND_STEEL || type == Material.FIRE_CHARGE
                || (type.name().endsWith("_BUCKET") && type != Material.MILK_BUCKET);
    }

    /** Somebody taking part, or anything in a box. */
    private boolean touches(Entity target) {
        return entrant(target) || (target != null && inside(target.getLocation(), 0));
    }

    /** Who is behind a blow: the player, the shooter of a projectile, the lighter of TNT. */
    private static Object culprit(Entity damager) {
        if (damager instanceof Projectile projectile) return projectile.getShooter();
        if (damager instanceof TNTPrimed tnt) return tnt.getSource();
        if (damager instanceof AreaEffectCloud cloud) return cloud.getSource();
        return damager;
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBreak(BlockBreakEvent event) {
        if (outsider(event.getPlayer()) && inside(event.getBlock())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPlace(BlockPlaceEvent event) {
        if (outsider(event.getPlayer()) && inside(event.getBlockPlaced())) event.setCancelled(true);
    }

    /** Not skipped when already refused: a click on the air arrives refused. */
    @EventHandler(priority = EventPriority.HIGHEST)
    public void onInteract(PlayerInteractEvent event) {
        Player player = event.getPlayer();
        if (!outsider(player)) return;
        Block clicked = event.getClickedBlock();
        boolean into = clicked != null && (inside(clicked) || inside(clicked.getRelative(event.getBlockFace())));
        Location where = clicked != null ? clicked.getLocation() : player.getLocation();
        if (into || (pours(event.getItem()) && over(where))) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPour(PlayerBucketEmptyEvent event) {
        if (outsider(event.getPlayer()) && over(event.getBlock().getLocation())) event.setCancelled(true);
    }

    /** Also {@code PlayerInteractAtEntityEvent}, which extends it. */
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onUseEntity(PlayerInteractEntityEvent event) {
        if (outsider(event.getPlayer()) && touches(event.getRightClicked())) event.setCancelled(true);
    }

    /** Hurt by an outsider any way at all - a blow, an arrow, their TNT. An
     *  explosion from outside a box never reaches the players in it. */
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onHurt(EntityDamageByEntityEvent event) {
        Entity victim = event.getEntity();
        if (outsider(culprit(event.getDamager())) && touches(victim)) {
            event.setCancelled(true);
            return;
        }
        boolean blast = event.getCause() == org.bukkit.event.entity.EntityDamageEvent.DamageCause.ENTITY_EXPLOSION;
        if (blast && entrant(victim) && !sameBox(victim.getLocation(), event.getDamager().getLocation()))
            event.setCancelled(true);
    }

    /** Whether two places are inside the same box. */
    private boolean sameBox(Location one, Location two) {
        if (!overworld(one.getWorld()) || !overworld(two.getWorld())) return false;
        for (Guard guard : live()) {
            Box box = guard.box();
            if (box.contains(one.getX(), one.getY(), one.getZ(), 0) && box.contains(two.getX(), two.getY(), two.getZ(), 0))
                return true;
        }
        return false;
    }

    /** An outsider's arrow, potion, pearl or snowball lands nowhere near a box. */
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onImpact(ProjectileHitEvent event) {
        Projectile projectile = event.getEntity();
        if (!outsider(projectile.getShooter())) return;
        if (entrant(event.getHitEntity()) || inside(projectile.getLocation(), SPLASH)) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onSplash(PotionSplashEvent event) {
        if (!outsider(event.getPotion().getShooter())) return;
        for (LivingEntity one : event.getAffectedEntities()) if (touches(one)) event.setIntensity(one, 0);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onCloud(AreaEffectCloudApplyEvent event) {
        ProjectileSource source = event.getEntity().getSource();
        if (outsider(source)) event.getAffectedEntities().removeIf(this::touches);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onEntityExplode(EntityExplodeEvent event) {
        spare(event.getLocation(), event.blockList());
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockExplode(BlockExplodeEvent event) {
        spare(event.getBlock().getLocation().add(0.5, 0.5, 0.5), event.blockList());
    }

    /** An explosion from outside a box leaves its blocks as they are. */
    private void spare(Location center, List<Block> blocks) {
        if (guards.isEmpty() || !overworld(center.getWorld())) return;
        for (Guard guard : live()) {
            Box box = guard.box();
            if (box.contains(center.getX(), center.getY(), center.getZ(), 0)) continue;
            blocks.removeIf(block -> box.contains(block.getX() + 0.5, block.getY() + 0.5, block.getZ() + 0.5, 0));
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPistonOut(BlockPistonExtendEvent event) {
        if (pistonReaches(event.getBlock(), event.getBlocks(), event.getDirection())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPistonIn(BlockPistonRetractEvent event) {
        if (pistonReaches(event.getBlock(), event.getBlocks(), event.getDirection())) event.setCancelled(true);
    }

    /** A piston outside a box moving anything in it, into it, or its head into it. */
    private boolean pistonReaches(Block piston, List<Block> moved, BlockFace direction) {
        if (guards.isEmpty() || inside(piston)) return false;
        if (inside(piston.getRelative(direction))) return true;
        for (Block block : moved) if (inside(block) || inside(block.getRelative(direction))) return true;
        return false;
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onFlow(BlockFromToEvent event) {
        if (inside(event.getToBlock()) && !inside(event.getBlock())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onSpread(BlockSpreadEvent event) {
        if (inside(event.getBlock()) && !inside(event.getSource())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onIgnite(BlockIgniteEvent event) {
        if (!inside(event.getBlock()) || entrant(event.getIgnitingEntity())) return;
        Block from = event.getIgnitingBlock();
        if (from == null || !inside(from)) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBurn(BlockBurnEvent event) {
        Block from = event.getIgnitingBlock();
        if (inside(event.getBlock()) && from != null && !inside(from)) event.setCancelled(true);
    }

    private void dismountOutsiders() {
        if (guards.isEmpty()) return;
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (player.isInsideVehicle() && outsider(player) && inside(player.getLocation(), 0)) player.leaveVehicle();
        }
    }
}
