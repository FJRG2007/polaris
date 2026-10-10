package com.scout.symbiote.ability;

import com.scout.symbiote.util.ItemCompat;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.tags.ItemTags;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.ExperienceOrb;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.Rarity;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;

public final class SymbioteScavengeReflex {
   public static final TagKey<Item> SCAVENGE_TAG = ItemTags.create(ResourceLocation.fromNamespaceAndPath("symbiote", "scavenge"));
   private static final Set<Item> CORE = Set.of(
      Items.DIAMOND,
      Items.DIAMOND_BLOCK,
      Items.EMERALD,
      Items.EMERALD_BLOCK,
      Items.NETHERITE_INGOT,
      Items.NETHERITE_SCRAP,
      Items.NETHERITE_BLOCK,
      Items.ANCIENT_DEBRIS,
      Items.NETHER_STAR,
      Items.TOTEM_OF_UNDYING,
      Items.ENCHANTED_BOOK,
      Items.ELYTRA
   );
   private static final int MAX_TENDRILS = 2;
   private static final int TIMEOUT_TICKS = 60;
   private static final int GRAB_LIFE = 80;
   private static final int COOLDOWN_TICKS = 20;
   private static final double CHEST_Y = 0.6;
   private static final double MAX_PER_TICK = 0.6;
   private static final double APPROACH_FRAC = 0.35;
   private static final Map<UUID, List<SymbioteScavengeReflex.Grab>> ACTIVE = new HashMap<>();
   private static final Map<UUID, Long> COOLDOWN = new HashMap<>();
   private static final Map<UUID, Integer> LAST_VOICED = new HashMap<>();
   private static final Map<UUID, Map<Integer, Long>> SNUBBED = new HashMap<>();
   private static final int SNUB_TICKS = 600;

   public static boolean isScavenging(UUID player) {
      List<SymbioteScavengeReflex.Grab> g = ACTIVE.get(player);
      return g != null && !g.isEmpty();
   }

   public static boolean isHighValue(ItemStack s) {
      if (s.isEmpty()) {
         return false;
      } else if (s.is(SCAVENGE_TAG)) {
         return true;
      } else if (CORE.contains(s.getItem())) {
         return true;
      } else if (s.isEnchanted()) {
         return true;
      } else if (s.getRarity() != Rarity.COMMON) {
         return true;
      } else {
         return ItemCompat.isFireResistant(s) ? true : s.isDamageableItem() && s.getMaxDamage() >= SymbioteConfig.SCAVENGE_MIN_DURABILITY.get();
      }
   }

   public static void maybeStart(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (SymbioteConfig.ARMS_ENABLED.get() && SymbioteConfig.ARMS_SCAVENGE.get()) {
         if (p != null && p.stage.isAtLeast(BondStage.COOPERATIVE)) {
            UUID id = player.getUUID();
            List<SymbioteScavengeReflex.Grab> grabs = ACTIVE.get(id);
            if (grabs == null || grabs.size() < 2) {
               if (!SymbioteFeedingHunt.isHunting(id)) {
                  long now = level.getGameTime();
                  Long cd = COOLDOWN.get(id);
                  if (cd == null || now >= cd) {
                     ItemEntity prize = findPrize(player, level, SymbioteConfig.ARMS_SCAVENGE_RANGE.get(), grabs);
                     if (prize != null) {
                        begin(player, level, p, prize, now);
                     } else {
                        ExperienceOrb orb = findOrb(player, level, SymbioteConfig.ARMS_SCAVENGE_RANGE.get(), grabs);
                        if (orb != null) {
                           beginOrb(player, level, p, orb, now);
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static ExperienceOrb findOrb(ServerPlayer player, ServerLevel level, double range, List<SymbioteScavengeReflex.Grab> existing) {
      AABB box = player.getBoundingBox().inflate(range);
      ExperienceOrb best = null;
      double bestSq = Double.MAX_VALUE;
      long now = level.getGameTime();

      for (ExperienceOrb o : level.getEntitiesOfClass(ExperienceOrb.class, box, e -> e.isAlive())) {
         if (!alreadyTargeted(existing, o.getId()) && !snubbed(player.getUUID(), o.getId(), now) && !anotherPlayerNear(level, player, o)) {
            double d = player.distanceToSqr(o);
            if (!(d < 4.0) && d < bestSq) {
               bestSq = d;
               best = o;
            }
         }
      }

      if (best != null && !canSee(player, best)) {
         snub(player.getUUID(), best.getId(), now);
         SymbioteLog.event("SCAVENGE_SNUB player={} orb={} reason=no_sight", player.getUUID(), best.getId());
         return null;
      } else {
         return best;
      }
   }

   private static void beginOrb(ServerPlayer player, ServerLevel level, SymbioteProfile p, ExperienceOrb orb, long now) {
      Vec3 pos = orb.position().add(0.0, 0.15, 0.0);
      TendrilFxEntity fx = TendrilMantle.beginJob(player, level, pos);
      boolean borrowed = fx != null;
      int reach = borrowed ? 8 : 8 + player.getRandom().nextInt(4);
      if (!borrowed) {
         float hoverAngle = (float)(player.getRandom().nextDouble() * Math.PI * 2.0);
         fx = TendrilFxEntity.spawnArm(level, player, pos, 80, p.strain, 2, reach, hoverAngle, ItemStack.EMPTY);
      }

      double speed = 0.85 + player.getRandom().nextDouble() * 0.3;
      ACTIVE.computeIfAbsent(player.getUUID(), k -> new ArrayList<>())
         .add(new SymbioteScavengeReflex.Grab(orb.getId(), now, fx.getId(), reach, speed, pos, borrowed, true));
      SymbioteLog.event("SCAVENGE_ORB_START player={} value={}", player.getUUID(), orb.getValue());
   }

   private static ItemEntity findPrize(ServerPlayer player, ServerLevel level, double range, List<SymbioteScavengeReflex.Grab> existing) {
      AABB box = player.getBoundingBox().inflate(range);
      Vec3 eye = player.getEyePosition();
      double maxSq = (range + 1.0) * (range + 1.0);
      ItemEntity best = null;
      double bestSq = Double.MAX_VALUE;
      long now = level.getGameTime();

      for (ItemEntity it : level.getEntitiesOfClass(ItemEntity.class, box, SymbioteScavengeReflex::eligible)) {
         if (!alreadyTargeted(existing, it.getId()) && !snubbed(player.getUUID(), it.getId(), now) && !anotherPlayerNear(level, player, it)) {
            double dSq = eye.distanceToSqr(it.getX(), it.getY() + 0.2, it.getZ());
            if (!(dSq > maxSq) && dSq < bestSq) {
               bestSq = dSq;
               best = it;
            }
         }
      }

      if (best != null && !canSee(player, best)) {
         snub(player.getUUID(), best.getId(), now);
         SymbioteLog.event("SCAVENGE_SNUB player={} item={} reason=no_sight", player.getUUID(), best.getId());
         return null;
      } else {
         return best;
      }
   }

   private static boolean snubbed(UUID player, int entityId, long now) {
      Map<Integer, Long> m = SNUBBED.get(player);
      if (m == null) {
         return false;
      } else {
         Long until = m.get(entityId);
         if (until == null) {
            return false;
         } else if (now >= until) {
            m.remove(entityId);
            return false;
         } else {
            return true;
         }
      }
   }

   private static void snub(UUID player, int entityId, long now) {
      if (SNUBBED.size() > 64) {
         SNUBBED.clear();
      }

      SNUBBED.computeIfAbsent(player, k -> new HashMap<>()).put(entityId, now + 600L);
   }

   private static boolean canSee(ServerPlayer player, Entity target) {
      return player.serverLevel()
            .clip(
               new ClipContext(
                  player.getEyePosition(), target.position().add(0.0, Math.max(0.1, target.getBbHeight() * 0.5), 0.0), Block.COLLIDER, Fluid.NONE, player
               )
            )
            .getType()
         == Type.MISS;
   }

   private static boolean anotherPlayerNear(ServerLevel level, ServerPlayer self, Entity it) {
      return !level.getEntitiesOfClass(Player.class, it.getBoundingBox().inflate(3.0), pl -> pl != self && pl.isAlive()).isEmpty();
   }

   private static boolean alreadyTargeted(List<SymbioteScavengeReflex.Grab> existing, int itemId) {
      if (existing == null) {
         return false;
      }

      for (SymbioteScavengeReflex.Grab g : existing) {
         if (g.itemId == itemId) {
            return true;
         }
      }

      return false;
   }

   private static boolean eligible(ItemEntity it) {
      if (!it.isAlive()) {
         return false;
      } else {
         return it.hasPickUpDelay() ? false : isHighValue(it.getItem());
      }
   }

   private static void begin(ServerPlayer player, ServerLevel level, SymbioteProfile p, ItemEntity prize, long now) {
      Vec3 pos = prize.position().add(0.0, 0.2, 0.0);
      TendrilFxEntity fx = TendrilMantle.beginJob(player, level, pos);
      boolean borrowed = fx != null;
      int reach = borrowed ? 8 : 10 + player.getRandom().nextInt(6);
      if (!borrowed) {
         float hoverAngle = (float)(player.getRandom().nextDouble() * Math.PI * 2.0);
         fx = TendrilFxEntity.spawnArm(level, player, pos, 80, p.strain, 2, reach, hoverAngle, ItemStack.EMPTY);
      }

      prize.setPickUpDelay(reach + 2);
      double speed = 0.85 + player.getRandom().nextDouble() * 0.3;
      ACTIVE.computeIfAbsent(player.getUUID(), k -> new ArrayList<>())
         .add(new SymbioteScavengeReflex.Grab(prize.getId(), now, fx.getId(), reach, speed, pos, borrowed));
      if (player.getRandom().nextFloat() < 0.15F && LAST_VOICED.getOrDefault(player.getUUID(), -1) != prize.getId()) {
         LAST_VOICED.put(player.getUUID(), prize.getId());
         VoiceLines.send(player, "symbiote.voice.scavenge", 0);
      }

      SymbioteLog.event("SCAVENGE_START player={} item={} dist={}", player.getUUID(), prize.getItem().getItem(), player.distanceTo(prize));
   }

   public static void tickAll(ServerLevel level) {
      if (!ACTIVE.isEmpty()) {
         long now = level.getGameTime();
         Iterator<Entry<UUID, List<SymbioteScavengeReflex.Grab>>> pit = ACTIVE.entrySet().iterator();

         while (pit.hasNext()) {
            Entry<UUID, List<SymbioteScavengeReflex.Grab>> e = pit.next();
            UUID id = e.getKey();
            List<SymbioteScavengeReflex.Grab> grabs = e.getValue();
            ServerPlayer player = level.getServer().getPlayerList().getPlayer(id);
            if (player == null || !player.isAlive()) {
               cleanupAll(level, grabs);
               pit.remove();
            } else if (player.serverLevel() == level) {
               SymbioteProfile p = SymbioteTracker.get(level).peek(id);
               if (p != null && p.stage.isAtLeast(BondStage.COOPERATIVE)) {
                  Iterator<SymbioteScavengeReflex.Grab> git = grabs.iterator();

                  while (git.hasNext()) {
                     SymbioteScavengeReflex.Grab g = git.next();
                     if (now - g.startTick > 60L) {
                        endFx(level, g, g.lastPos);
                        snub(id, g.itemId, now);
                        COOLDOWN.put(id, now + 20L);
                        git.remove();
                        SymbioteLog.event("SCAVENGE_END player={} reason=timeout", id);
                     } else {
                        Entity ent = level.getEntity(g.itemId);
                        if (g.orb) {
                           if (ent instanceof ExperienceOrb xp && xp.isAlive()) {
                              Vec3 opos = xp.position().add(0.0, 0.15, 0.0);
                              g.lastPos = opos;
                              if (level.getEntity(g.fxId) instanceof TendrilFxEntity ofx) {
                                 ofx.setTargetPos(opos.x, opos.y, opos.z);
                              }

                              if (now - g.startTick >= g.reachTicks) {
                                 Vec3 odst = new Vec3(player.getX(), player.getY() + 0.6, player.getZ());
                                 Vec3 oto = odst.subtract(opos);
                                 double olen = oto.length();
                                 if (!(olen < 1.0E-4)) {
                                    double ostep = Math.min(olen * 0.35, 0.6) * g.speed;
                                    xp.setDeltaMovement(oto.scale(ostep / olen));
                                    xp.hasImpulse = true;
                                 }
                              }
                           } else {
                              endFx(level, g, g.lastPos);
                              git.remove();
                              SymbioteLog.event("SCAVENGE_END player={} reason=orb_collected_or_gone", id);
                           }
                        } else if (ent instanceof ItemEntity item && item.isAlive()) {
                           Vec3 ipos = item.position().add(0.0, 0.2, 0.0);
                           g.lastPos = ipos;
                           if (level.getEntity(g.fxId) instanceof TendrilFxEntity fx) {
                              fx.setTargetPos(ipos.x, ipos.y, ipos.z);
                           }

                           if (now - g.startTick < g.reachTicks) {
                              item.setPickUpDelay((int)(g.reachTicks - (now - g.startTick)) + 2);
                           } else {
                              item.setNoPickUpDelay();
                              if (now - g.startTick == g.reachTicks) {
                                 level.playSound(
                                    null,
                                    ipos.x,
                                    ipos.y,
                                    ipos.z,
                                    (SoundEvent)ModSounds.TENDRIL_GRIP.get(),
                                    SoundSource.PLAYERS,
                                    0.5F,
                                    1.0F
                                 );
                              }

                              Vec3 dst = new Vec3(player.getX(), player.getY() + 0.6, player.getZ());
                              Vec3 to = dst.subtract(ipos);
                              double len = to.length();
                              if (!(len < 1.0E-4)) {
                                 double step = Math.min(len * 0.35, 0.6) * g.speed;
                                 item.setDeltaMovement(to.scale(step / len));
                                 item.hasImpulse = true;
                                 item.fallDistance = 0.0F;
                              }
                           }
                        } else {
                           endFx(level, g, g.lastPos);
                           git.remove();
                           SymbioteLog.event("SCAVENGE_END player={} reason=collected_or_gone", id);
                        }
                     }
                  }

                  if (grabs.isEmpty()) {
                     pit.remove();
                  }
               } else {
                  for (SymbioteScavengeReflex.Grab g : grabs) {
                     endFx(level, g, g.lastPos);
                  }

                  COOLDOWN.put(id, now + 20L);
                  pit.remove();
               }
            }
         }
      }
   }

   private static void endFx(ServerLevel level, SymbioteScavengeReflex.Grab g, Vec3 tip) {
      if (g.mantleLimb) {
         if (level.getEntity(g.fxId) instanceof TendrilFxEntity fx) {
            TendrilMantle.endJob(level, fx);
         }
      } else {
         retractFx(level, g, tip);
      }
   }

   private static void retractFx(ServerLevel level, SymbioteScavengeReflex.Grab g, Vec3 tip) {
      if (level.getEntity(g.fxId) instanceof TendrilFxEntity fx) {
         fx.setTargetId(0);
         fx.setTargetPos(tip.x, tip.y, tip.z);
         fx.setTransitionFrom(tip.x, tip.y, tip.z, fx.tickCount);
         fx.setRetractStartTick(fx.tickCount);
         fx.setLifetime(fx.tickCount + 16);
      }
   }

   private static void cleanupAll(ServerLevel level, List<SymbioteScavengeReflex.Grab> grabs) {
      for (SymbioteScavengeReflex.Grab g : grabs) {
         if (g.mantleLimb) {
            if (level.getEntity(g.fxId) instanceof TendrilFxEntity fx) {
               TendrilMantle.endJob(level, fx);
            }
         } else {
            Entity e = level.getEntity(g.fxId);
            if (e != null) {
               e.discard();
            }
         }
      }
   }

   public static void clear(UUID player) {
      ACTIVE.remove(player);
      COOLDOWN.remove(player);
      LAST_VOICED.remove(player);
   }

   public static void forceClear(ServerLevel level, UUID player) {
      List<SymbioteScavengeReflex.Grab> grabs = ACTIVE.remove(player);
      if (grabs != null) {
         cleanupAll(level, grabs);
      }

      COOLDOWN.remove(player);
   }

   public static void onLogout(UUID player) {
      ACTIVE.remove(player);
      COOLDOWN.remove(player);
      LAST_VOICED.remove(player);
      SNUBBED.remove(player);
   }

   private SymbioteScavengeReflex() {
   }

   static final class Grab {
      final int itemId;
      final long startTick;
      final int fxId;
      final int reachTicks;
      final double speed;
      final boolean mantleLimb;
      final boolean orb;
      Vec3 lastPos;

      Grab(int itemId, long startTick, int fxId, int reachTicks, double speed, Vec3 lastPos, boolean mantleLimb) {
         this(itemId, startTick, fxId, reachTicks, speed, lastPos, mantleLimb, false);
      }

      Grab(int itemId, long startTick, int fxId, int reachTicks, double speed, Vec3 lastPos, boolean mantleLimb, boolean orb) {
         this.itemId = itemId;
         this.startTick = startTick;
         this.fxId = fxId;
         this.reachTicks = reachTicks;
         this.speed = speed;
         this.lastPos = lastPos;
         this.mantleLimb = mantleLimb;
         this.orb = orb;
      }
   }
}
