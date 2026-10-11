package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.item.BucketItem;
import net.minecraft.world.item.FireChargeItem;
import net.minecraft.world.item.FlintAndSteelItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelAccessor;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.neoforge.event.entity.ProjectileImpactEvent;
import net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent;
import net.neoforged.neoforge.event.entity.player.AttackEntityEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.neoforged.neoforge.event.level.BlockEvent;
import net.neoforged.neoforge.event.level.ExplosionEvent;
import net.neoforged.neoforge.event.level.PistonEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

/**
 * Nobody outside an event can change it.
 *
 * {@code polaris guard set <key> <x1> <y1> <z1> <x2> <y2> <z2>} marks a box in
 * the Overworld as an event's space while the event under {@code key} lasts;
 * {@code polaris guard clear <key>} lets it go, and a box not set again for
 * {@link #KEPT_MS} lets itself go, so one whose clear never came cannot stay.
 * The dashboard sets it again every half minute, so a restart of the server
 * loses it for that long at most.
 *
 * Who takes part is told by the tags the dashboard puts on everybody it takes
 * in, before it moves them, and takes off once they are back
 * ({@link #ENTRANT_TAGS}): the tags are the list, kept by the world itself, so
 * there is nothing to send again when somebody joins. Anybody else - operators
 * and creative players included - cannot break, place or use a block in the
 * box, use anything in it, hit, shoot or splash anybody taking part, pour or
 * light anything over it, or ride into it; an explosion from outside leaves
 * its blocks and its players alone, a piston outside cannot push into it, and
 * a fluid outside cannot flow into it ({@code FluidSpreadMixin}). Fire
 * spreading in by itself is not stopped on NeoForge, which has no event for it.
 *
 * The dashboard also holds outsiders in adventure mode near the box and moves
 * them out of it from its own tick; this is the half that needs the mod.
 */
public final class EventGuard {
    /** Kept in step with `IN_ARENA` in `kinds/arena.ts` and `kinds/stage.ts`. */
    static final String[] ENTRANT_TAGS = {"pe_arena", "pe_in"};
    /** How long a box stands without being set again. */
    static final long KEPT_MS = 10 * 60_000L;
    /** Blocks round a box over which pouring or lighting is refused, at any height. */
    private static final int POUR_MARGIN = 8;
    /** Blocks round a box from which a piston could reach into it. */
    private static final int PISTON_REACH = 13;
    /** Blocks round a box a splash reaches into it from. */
    private static final double SPLASH = 4.5;

    private record Guard(String key, AABB box, long until) {}

    private static final Map<String, Guard> guards = new ConcurrentHashMap<>();

    static JsonObject set(String key, int x1, int y1, int z1, int x2, int y2, int z2) {
        AABB box = new AABB(
                Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2),
                Math.max(x1, x2) + 1, Math.max(y1, y2) + 1, Math.max(z1, z2) + 1);
        guards.put(key, new Guard(key, box, System.currentTimeMillis() + KEPT_MS));
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        return reply;
    }

    static JsonObject clear(String key) {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("cleared", guards.remove(key) != null ? 1 : 0);
        return reply;
    }

    static JsonObject list() {
        JsonArray keys = new JsonArray();
        for (Guard guard : live()) keys.add(guard.key());
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.add("keys", keys);
        return reply;
    }

    private static Iterable<Guard> live() {
        long now = System.currentTimeMillis();
        guards.values().removeIf(guard -> guard.until() < now);
        return guards.values();
    }

    /** Taking part: carries an event's tag. Anything that is not a player never is. */
    static boolean entrant(Entity entity) {
        if (entity == null) return false;
        for (String tag : ENTRANT_TAGS) if (entity.getTags().contains(tag)) return true;
        return false;
    }

    /** Somebody who may not touch an event: a player not taking part, spectators aside. */
    private static boolean outsider(Entity entity) {
        return entity instanceof Player player && !player.isSpectator() && !entrant(player);
    }

    private static boolean overworld(LevelAccessor level) {
        return level instanceof Level world && world.dimension() == Level.OVERWORLD;
    }

    private static boolean inside(LevelAccessor level, Vec3 at, double grow) {
        if (guards.isEmpty() || !overworld(level)) return false;
        for (Guard guard : live()) if (guard.box().inflate(grow).contains(at)) return true;
        return false;
    }

    private static boolean inside(LevelAccessor level, BlockPos pos) {
        return inside(level, Vec3.atCenterOf(pos), 0);
    }

    /** Over a box or beside it, at any height: where a fluid poured or a fire lit runs into it. */
    private static boolean over(LevelAccessor level, BlockPos pos) {
        if (guards.isEmpty() || !overworld(level)) return false;
        Vec3 at = Vec3.atCenterOf(pos);
        for (Guard guard : live()) {
            AABB box = guard.box().inflate(POUR_MARGIN, 0, POUR_MARGIN);
            if (at.x >= box.minX && at.x < box.maxX && at.z >= box.minZ && at.z < box.maxZ) return true;
        }
        return false;
    }

    private static boolean pours(ItemStack stack) {
        return stack.getItem() instanceof BucketItem
                || stack.getItem() instanceof FlintAndSteelItem
                || stack.getItem() instanceof FireChargeItem;
    }

    /** Whether a fluid flowing {@code direction} onto {@code to} would run into a box from outside it. */
    public static boolean refusesFlow(LevelAccessor level, BlockPos to, Direction direction) {
        return inside(level, to) && !inside(level, to.relative(direction.getOpposite()));
    }

    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onBreak(BlockEvent.BreakEvent event) {
        if (outsider(event.getPlayer()) && inside(event.getLevel(), event.getPos())) event.setCanceled(true);
    }

    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onPlace(BlockEvent.EntityPlaceEvent event) {
        if (outsider(event.getEntity()) && inside(event.getLevel(), event.getPos())) event.setCanceled(true);
    }

    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onUseBlock(PlayerInteractEvent.RightClickBlock event) {
        if (!outsider(event.getEntity())) return;
        BlockPos pos = event.getPos();
        Direction face = event.getFace();
        boolean into = inside(event.getLevel(), pos) || (face != null && inside(event.getLevel(), pos.relative(face)));
        if (into || (pours(event.getItemStack()) && over(event.getLevel(), pos))) event.setCanceled(true);
    }

    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onUseItem(PlayerInteractEvent.RightClickItem event) {
        Player player = event.getEntity();
        if (outsider(player) && pours(event.getItemStack()) && over(event.getLevel(), player.blockPosition()))
            event.setCanceled(true);
    }

    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onHitBlock(PlayerInteractEvent.LeftClickBlock event) {
        if (outsider(event.getEntity()) && inside(event.getLevel(), event.getPos())) event.setCanceled(true);
    }

    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onUseEntity(PlayerInteractEvent.EntityInteract event) {
        if (outsider(event.getEntity()) && touches(event.getTarget())) event.setCanceled(true);
    }

    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onUseEntityAt(PlayerInteractEvent.EntityInteractSpecific event) {
        if (outsider(event.getEntity()) && touches(event.getTarget())) event.setCanceled(true);
    }

    /** Somebody taking part, or anything in a box. */
    private static boolean touches(Entity target) {
        return entrant(target) || inside(target.level(), target.position(), 0);
    }

    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onAttack(AttackEntityEvent event) {
        if (outsider(event.getEntity()) && touches(event.getTarget())) event.setCanceled(true);
    }

    /** Hurt by an outsider any way at all - a blow, an arrow, their TNT - while taking part. */
    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onHurt(LivingIncomingDamageEvent event) {
        if (entrant(event.getEntity()) && outsider(event.getSource().getEntity())) event.setCanceled(true);
    }

    /** An outsider's arrow, potion, pearl or snowball lands nowhere near a box. */
    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onImpact(ProjectileImpactEvent event) {
        Projectile projectile = event.getProjectile();
        if (!outsider(projectile.getOwner())) return;
        HitResult hit = event.getRayTraceResult();
        boolean onEntrant = hit instanceof EntityHitResult entity && entrant(entity.getEntity());
        if (onEntrant || inside(projectile.level(), hit.getLocation(), SPLASH)) event.setCanceled(true);
    }

    /** An explosion from outside a box leaves its blocks and its players as they are. */
    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onExplode(ExplosionEvent.Detonate event) {
        Level level = event.getLevel();
        if (guards.isEmpty() || !overworld(level)) return;
        Vec3 center = event.getExplosion().center();
        for (Guard guard : live()) {
            AABB box = guard.box();
            if (box.contains(center)) continue;
            event.getAffectedBlocks().removeIf(pos -> box.contains(Vec3.atCenterOf(pos)));
            event.getAffectedEntities().removeIf(entity -> box.contains(entity.position()));
        }
        event.getAffectedEntities().removeIf(entity -> entrant(entity) && !sameBox(entity.position(), center));
    }

    /** Whether two places are inside the same box. */
    private static boolean sameBox(Vec3 one, Vec3 two) {
        for (Guard guard : live()) if (guard.box().contains(one) && guard.box().contains(two)) return true;
        return false;
    }

    /** A piston outside a box never pushes or pulls into it. */
    @SubscribeEvent(priority = EventPriority.HIGHEST)
    public void onPiston(PistonEvent.Pre event) {
        LevelAccessor level = event.getLevel();
        BlockPos pos = event.getPos();
        if (inside(level, pos)) return;
        if (inside(level, Vec3.atCenterOf(pos), PISTON_REACH)) event.setCanceled(true);
    }

    private int ticks;

    /** Twice a second: nobody outside rides into a box. */
    @SubscribeEvent
    public void onTick(ServerTickEvent.Post event) {
        if (guards.isEmpty() || ++ticks % 10 != 0) return;
        MinecraftServer server = event.getServer();
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            if (player.getVehicle() != null && outsider(player) && inside(player.level(), player.position(), 0))
                player.stopRiding();
        }
    }
}
