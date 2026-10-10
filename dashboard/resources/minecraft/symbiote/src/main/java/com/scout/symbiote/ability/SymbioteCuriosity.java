package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.event.HeldGravityGuard;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.animal.WaterAnimal;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.npc.Villager;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.level.biome.Biomes;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;

public final class SymbioteCuriosity {
   private static final double STARE_REACH = 4.5;
   private static final int STARE_TICKS = 60;
   private static final int FIDGET_ROLL_GAP = 400;
   private static final Map<UUID, Map<String, Long>> FEAR_FRESH = new HashMap<>();
   private static final int MEMORY_AGE_TICKS = 2400;
   private static final Map<UUID, Integer> WATCH = new HashMap<>();
   private static final Map<UUID, BlockPos> WATCH_DEST = new HashMap<>();
   private static final Map<UUID, Long> WATCH_HIDDEN_SINCE = new HashMap<>();
   private static final int HIDDEN_BAIL_TICKS = 40;
   private static final Map<UUID, long[]> PENDING_WALK = new HashMap<>();
   private static final Map<UUID, SymbioteCuriosity.Stare> STARING = new HashMap<>();
   private static final Map<UUID, double[]> IDLE_POS = new HashMap<>();
   private static final Map<UUID, Integer> IDLE_TICKS = new HashMap<>();
   private static final Map<UUID, Long> LAST_FIDGET = new HashMap<>();
   private static final Set<UUID> REPOSITIONED = new HashSet<>();
   private static final Map<UUID, Long> VILLAGER_LOOK_LAST = new HashMap<>();
   private static final Map<Integer, Vec3[]> PRODDING = new HashMap<>();

   public static void noteFearFresh(UUID player, String species, long now) {
      Map<String, Long> m = FEAR_FRESH.computeIfAbsent(player, k -> new HashMap<>());
      if (m.size() > 64) {
         m.clear();
      }

      m.put(species, now);
   }

   private static boolean fearIsFresh(UUID player, String species, long now) {
      Map<String, Long> m = FEAR_FRESH.get(player);
      Long t = m == null ? null : m.get(species);
      return t != null && now - t < 2400L;
   }

   public static boolean isStaring(UUID player) {
      return STARING.containsKey(player);
   }

   public static void noteSeenCombat(ServerPlayer player, ServerLevel level, LivingEntity other) {
      SymbioteProfile prof = SymbioteTracker.get(level).peek(player.getUUID());
      if (prof != null && prof.stage.isBonded()) {
         String id = speciesId(other);
         if (!id.startsWith("symbiote:")) {
            if (prof.seenSpecies.add(id)) {
               SymbioteTracker.get(level).setDirty();
            }
         }
      }
   }

   private static boolean meaningfullyVisible(ServerPlayer player, LivingEntity e) {
      Vec3 from = player.getEyePosition();
      int clear = 0;
      double[] heights = new double[]{e.getEyeHeight(), e.getBbHeight() * 0.5, 0.1};

      for (double h : heights) {
         Vec3 to = e.position().add(0.0, h, 0.0);
         if (player.level().clip(new ClipContext(from, to, Block.COLLIDER, Fluid.NONE, player)).getType() == Type.MISS) {
            if (++clear >= 2) {
               return true;
            }
         }
      }

      return false;
   }

   public static void tickActive(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      SymbioteCuriosity.Stare stare = STARING.get(player.getUUID());
      if (stare != null) {
         if (now < stare.until && player.hurtTime <= 0 && !FirePanicEscape.isActive(player.getUUID()) && !player.isOnFire() && !player.isInLava()) {
            if (level.getEntity(stare.targetId) instanceof LivingEntity held && held.isAlive() && held.distanceToSqr(player) < 36.0) {
               if (held.getY() < stare.liftY) {
                  held.setDeltaMovement(0.0, 0.12, 0.0);
               } else {
                  held.setDeltaMovement(Vec3.ZERO);
               }

               held.hurtMarked = true;
               held.fallDistance = 0.0F;
               if (held instanceof Mob m) {
                  m.getNavigation().stop();
               }

               if (now % 10L == 0L) {
                  ModNetwork.sendOverrideFx(player, "preylock:" + held.getId(), 16);
               }
            }
         } else {
            endStare(player, now >= stare.until);
         }
      } else {
         Integer targetId = WATCH.get(player.getUUID());
         if (targetId != null) {
            boolean walking = WalkSeizure.isActive(player.getUUID());
            if (level.getEntity(targetId) instanceof LivingEntity target && target.isAlive()) {
               BlockPos dest = WATCH_DEST.get(player.getUUID());
               if (dest != null && target.distanceToSqr(dest.getX() + 0.5, dest.getY(), dest.getZ() + 0.5) > 36.0) {
                  WATCH.remove(player.getUUID());
                  WATCH_DEST.remove(player.getUUID());
                  WATCH_HIDDEN_SINCE.remove(player.getUUID());
                  REPOSITIONED.remove(player.getUUID());
                  WalkSeizure.abort(player, level, p, "curiosity_target_strayed");
                  VoiceLines.send(player, "symbiote.voice.curiosity_lost", 0);
                  SymbioteLog.event("CURIOSITY_LOST_INTEREST player={} reason=strayed", player.getUUID());
               } else {
                  if (now % 10L == 0L) {
                     if (meaningfullyVisible(player, target)) {
                        WATCH_HIDDEN_SINCE.remove(player.getUUID());
                     } else {
                        long hiddenSince = WATCH_HIDDEN_SINCE.computeIfAbsent(player.getUUID(), k -> now);
                        if (now - hiddenSince >= 40L) {
                           WATCH.remove(player.getUUID());
                           WATCH_DEST.remove(player.getUUID());
                           WATCH_HIDDEN_SINCE.remove(player.getUUID());
                           WalkSeizure.abort(player, level, p, "curiosity_target_hidden");
                           VoiceLines.send(player, "symbiote.voice.curiosity_lost", 0);
                           SymbioteLog.event("CURIOSITY_LOST_INTEREST player={} reason=hidden", player.getUUID());
                           return;
                        }
                     }
                  }

                  boolean clearPath = player.distanceToSqr(target) <= 20.25
                     && level.clip(
                              new ClipContext(
                                 player.position().add(0.0, player.getBbHeight() * 0.6, 0.0),
                                 target.position().add(0.0, target.getBbHeight() * 0.5, 0.0),
                                 Block.COLLIDER,
                                 Fluid.NONE,
                                 player
                              )
                           )
                           .getType()
                        == Type.MISS;
                  if (clearPath) {
                     WATCH.remove(player.getUUID());
                     WATCH_DEST.remove(player.getUUID());
                     WATCH_HIDDEN_SINCE.remove(player.getUUID());
                     REPOSITIONED.remove(player.getUUID());
                     WalkSeizure.abort(player, level, p, "curious_look");
                     SymbioteCuriosity.Stare s = new SymbioteCuriosity.Stare();
                     s.targetId = targetId;
                     s.until = now + 60L;
                     s.liftY = target.getY() + 1.1;
                     STARING.put(player.getUUID(), s);
                     ModNetwork.sendBodySeized(player, true, false);
                     if (target.isPassenger()) {
                        target.stopRiding();
                     }

                     if (target.isVehicle()) {
                        target.ejectPassengers();
                     }

                     target.setNoGravity(true);
                     HeldGravityGuard.mark(target);
                     TendrilFxEntity fx = TendrilMantle.timedJob(
                        player, level, target.position().add(0.0, target.getBbHeight() * 0.6, 0.0), 8, 60, 2, ItemStack.EMPTY
                     );
                     if (fx == null) {
                        fx = TendrilFxEntity.spawnGrab(level, player, target, 74, p.strain);
                     }

                     fx.setWrapTarget(target.getId());
                     ModNetwork.sendOverrideFx(player, "preylock:" + target.getId(), 20);
                     SymbioteLog.event("CURIOSITY_STARE player={} target={}", player.getUUID(), target.getType());
                  } else {
                     if (!walking) {
                        if (player.distanceToSqr(target) <= 20.25
                           && REPOSITIONED.add(player.getUUID())
                           && WalkSeizure.start(player, level, p, target.blockPosition(), true)) {
                           SymbioteLog.event("CURIOSITY_REPOSITION player={} target={}", player.getUUID(), target.getType());
                           return;
                        }

                        WATCH.remove(player.getUUID());
                        WATCH_DEST.remove(player.getUUID());
                        WATCH_HIDDEN_SINCE.remove(player.getUUID());
                        REPOSITIONED.remove(player.getUUID());
                        if (!CombatSense.inCombat(player)) {
                           VoiceLines.send(player, "symbiote.voice.curiosity_lost", 0);
                        }

                        SymbioteLog.event("CURIOSITY_LOST_INTEREST player={} reason=walk_died", player.getUUID());
                     }
                  }
               }
            } else {
               WATCH.remove(player.getUUID());
               WATCH_DEST.remove(player.getUUID());
               WATCH_HIDDEN_SINCE.remove(player.getUUID());
               REPOSITIONED.remove(player.getUUID());
               WalkSeizure.abort(player, level, p, "curiosity_target_gone");
               VoiceLines.send(player, "symbiote.voice.curiosity_lost", 0);
               SymbioteLog.event("CURIOSITY_LOST_INTEREST player={} reason=gone", player.getUUID());
            }
         }
      }
   }

   public static boolean isFocused(UUID player) {
      return WATCH.containsKey(player) || STARING.containsKey(player);
   }

   public static void abortStare(ServerPlayer player) {
      if (STARING.containsKey(player.getUUID())) {
         endStare(player, false);
      }
   }

   private static void endStare(ServerPlayer player, boolean satisfied) {
      SymbioteCuriosity.Stare st = STARING.remove(player.getUUID());
      REPOSITIONED.remove(player.getUUID());
      ModNetwork.sendBodySeized(player, false, false);
      ServerLevel level = player.serverLevel();
      LivingEntity held = st != null && level.getEntity(st.targetId) instanceof LivingEntity le && le.isAlive() ? le : null;
      if (held != null) {
         held.setNoGravity(false);
         HeldGravityGuard.release(held);
      }

      boolean squished = false;
      if (satisfied && held != null && isSquishable(held)) {
         SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
         float squishChance = p != null && p.strain == SymbioteStrain.PREDATOR ? 0.85F : 0.6F;
         if (p != null && player.getRandom().nextFloat() < squishChance && GroundSlam.force(player, level, p, held)) {
            squished = true;
            SymbioteLog.event("CURIOSITY_SQUISH player={} target={}", player.getUUID(), held.getType());
         }
      }

      if (satisfied && !squished) {
         VoiceLines.send(player, "symbiote.voice.curiosity_done", 0);
      }

      SymbioteLog.event("CURIOSITY_STARE_END player={} satisfied={}", player.getUUID(), satisfied);
   }

   private static boolean isSquishable(LivingEntity e) {
      boolean kind = e instanceof Animal || e instanceof Villager;
      return !kind ? false : !(Boolean)SymbioteConfig.PROTECT_ALLIES.get() || !(e instanceof TamableAnimal t && t.isTame()) && !e.hasCustomName();
   }

   public static void tickStart(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      trackIdle(player);
      if ((Boolean)SymbioteConfig.CURIOSITY_ENABLED.get()) {
         if (player.isOnFire() || player.isInLava()) {
            ChestCuriosity.abortForEmergency(player, level, now, "burning");
         } else if (p.isStarving()) {
            ChestCuriosity.abortForEmergency(player, level, now, "starving");
         } else if (!SymbioteMolt.isMolting(p, now)) {
            if (p.instabilityUntilTick <= now) {
               if (now % 100L < 20L && level.getBiome(player.blockPosition()).is(Biomes.DEEP_DARK)) {
                  noteEncounter(player, level, "first_deep_dark", "symbiote.voice.encounter_deep_dark");
               }

               tickPendingWalk(player, level, p, now);
               maybeFidget(player, level, p, now);
               maybeNotice(player, level, p, now);
               ChestCuriosity.tick(player, level, p, now);
            }
         }
      }
   }

   private static void maybeNotice(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (now - p.lastCuriosityTick >= SymbioteConfig.CURIOSITY_MIN_GAP_TICKS.get().intValue()) {
         double moodAppetite = MoodEngine.curiosityMult(MoodEngine.current(p));
         if (!(moodAppetite <= 0.0)) {
            if (!CombatSense.inCombat(player, 200) && !p.isStarving()) {
               if (p.desireType < 0 || now >= p.desireDeadline) {
                  if (!WalkSeizure.isActive(player.getUUID())
                     && !DeepSeizure.isActive(player.getUUID())
                     && !TendrilSceneController.isInScene(player.getUUID())
                     && !FirePanicEscape.isActive(player.getUUID())
                     && !SymbioteFeedingHunt.isHunting(player.getUUID())
                     && !STARING.containsKey(player.getUUID())) {
                     double range = SymbioteConfig.CURIOSITY_RANGE.get();
                     LivingEntity novel = null;
                     LivingEntity feared = null;
                     double bestSq = Double.MAX_VALUE;

                     for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(range), en -> en != player && en.isAlive())) {
                        if (!(e instanceof Player) && !(e instanceof ArmorStand) && meaningfullyVisible(player, e) && !e.isInWater() && !e.isUnderWater()) {
                           String id = speciesId(e);
                           if (!id.startsWith("symbiote:")) {
                              if (p.fearedSpecies.contains(id)) {
                                 if (feared == null && e.distanceToSqr(player) < 144.0) {
                                    feared = e;
                                 }
                              } else if (!p.seenSpecies.contains(id)
                                 || e instanceof Villager && now - VILLAGER_LOOK_LAST.getOrDefault(player.getUUID(), 0L) >= 12000L) {
                                 double d = e.distanceToSqr(player);
                                 if (d < bestSq) {
                                    bestSq = d;
                                    novel = e;
                                 }
                              }
                           }
                        }
                     }

                     if (novel == null) {
                        if (feared != null && fearIsFresh(player.getUUID(), speciesId(feared), now)) {
                           feared = null;
                        }

                        if (feared != null && level.random.nextFloat() < 0.5F) {
                           p.lastCuriosityTick = now;
                           VoiceLines.send(player, "symbiote.voice.aversion", 4);
                           ModNetwork.sendOverrideFx(player, "gaze:" + feared.getId(), 30);
                           SymbioteLog.event("AVERSION_FLINCH player={} species={}", player.getUUID(), speciesId(feared));
                        }
                     } else {
                        String id = speciesId(novel);
                        p.seenSpecies.add(id);
                        p.lastCuriosityTick = now;
                        SymbioteTracker.get(level).setDirty();
                        SymbioteLog.event("CURIOSITY_NOTICE player={} species={} dist={}", player.getUUID(), id, String.format("%.1f", Math.sqrt(bestSq)));
                        boolean villager = novel instanceof Villager;
                        boolean wantsWalk = !(novel instanceof Enemy)
                           && !(novel instanceof WaterAnimal)
                           && !novel.isInWater()
                           && p.stage.isAtLeast(BondStage.INTEGRATED)
                           && level.getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(12.0), m -> m.isAlive() && m instanceof Enemy).isEmpty()
                           && level.random.nextDouble() < SymbioteConfig.CURIOSITY_WALK_CHANCE.get() * moodAppetite;
                        if (wantsWalk) {
                           PENDING_WALK.put(player.getUUID(), new long[]{novel.getId(), now + 40L});
                           if (novel instanceof Villager) {
                              VILLAGER_LOOK_LAST.put(player.getUUID(), now);
                           }

                           ModNetwork.sendOverrideFx(player, "gaze:" + novel.getId(), 45);
                           TendrilMantle.noteFixation(player, novel);
                           SymbioteLog.event("CURIOSITY_WALK_STAGED player={} species={}", player.getUUID(), id);
                        } else {
                           VoiceLines.send(player, villager ? "symbiote.voice.curiosity_villager" : "symbiote.voice.curiosity_notice", 0);
                           ModNetwork.sendOverrideFx(player, "gaze:" + novel.getId(), 40);
                           TendrilMantle.noteFixation(player, novel);
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static void tickPendingWalk(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      long[] pending = PENDING_WALK.get(player.getUUID());
      if (pending != null) {
         if (now >= pending[1]) {
            PENDING_WALK.remove(player.getUUID());
            if (!WalkSeizure.isActive(player.getUUID()) && !DeepSeizure.isActive(player.getUUID()) && !STARING.containsKey(player.getUUID())) {
               if (level.getEntity((int)pending[0]) instanceof LivingEntity target
                  && target.isAlive()
                  && !target.isInWater()
                  && !(target.distanceToSqr(player) > 784.0)
                  && WalkSeizure.start(player, level, p, target.blockPosition(), true)) {
                  VoiceLines.send(player, "symbiote.voice.curiosity_walk", 0);
                  ModNetwork.sendOverrideFx(player, "gaze:" + target.getId(), 45);
                  TendrilMantle.noteFixation(player, target);
                  WATCH.put(player.getUUID(), target.getId());
                  WATCH_DEST.put(player.getUUID(), target.blockPosition());
                  SymbioteLog.event("CURIOSITY_WALK player={} species={}", player.getUUID(), speciesId(target));
               } else {
                  SymbioteLog.event("CURIOSITY_WALK_FIZZLED player={}", player.getUUID());
               }
            }
         }
      }
   }

   private static void trackIdle(ServerPlayer player) {
      double[] last = IDLE_POS.get(player.getUUID());
      double x = player.getX();
      double z = player.getZ();
      if (last != null && !(Math.abs(x - last[0]) + Math.abs(z - last[1]) > 0.05)) {
         IDLE_TICKS.merge(player.getUUID(), 20, Integer::sum);
      } else {
         IDLE_POS.put(player.getUUID(), new double[]{x, z});
         IDLE_TICKS.put(player.getUUID(), 0);
      }
   }

   private static void maybeFidget(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      tickProds(level);
      if ((Boolean)SymbioteConfig.FIDGET_ENABLED.get()) {
         if (MoodEngine.current(p) != MoodEngine.Mood.GRIEVING) {
            if (IDLE_TICKS.getOrDefault(player.getUUID(), 0) >= SymbioteConfig.FIDGET_IDLE_TICKS.get()) {
               if (now - LAST_FIDGET.getOrDefault(player.getUUID(), 0L) >= 400L) {
                  if (!CombatSense.inCombat(player)
                     && !TendrilSceneController.isInScene(player.getUUID())
                     && !WalkSeizure.isActive(player.getUUID())
                     && !DeepSeizure.isActive(player.getUUID())) {
                     if (!(level.random.nextFloat() > 0.15F)) {
                        LAST_FIDGET.put(player.getUUID(), now);
                        boolean rain = level.isRaining() && level.canSeeSky(player.blockPosition().above());
                        int count = 1 + level.random.nextInt(2);
                        int spawned = 0;

                        for (int t = 0; t < count; t++) {
                           Vec3 point = null;
                           if (rain && t == 0) {
                              Vec3 look = player.getLookAngle();
                              point = player.getEyePosition().add(look.x * 0.6, 2.0, look.z * 0.6);
                           } else {
                              for (int i = 0; i < 10 && point == null; i++) {
                                 BlockPos c = player.blockPosition()
                                    .offset(level.random.nextInt(7) - 3, level.random.nextInt(3) - 1, level.random.nextInt(7) - 3);
                                 if (!level.getBlockState(c).isAir() && level.getBlockState(c.above()).isAir()) {
                                    point = Vec3.atCenterOf(c).add(0.0, 0.55, 0.0);
                                 }
                              }
                           }

                           if (point != null) {
                              TendrilFxEntity fx = TendrilMantle.timedJob(player, level, point, 6, 36, 2, ItemStack.EMPTY);
                              if (fx == null) {
                                 fx = TendrilFxEntity.spawnGrabAtPoint(level, player, point, 56, p.strain);
                              }

                              Vec3 axis = point.subtract(player.getEyePosition());
                              if (axis.lengthSqr() > 1.0E-4) {
                                 PRODDING.put(fx.getId(), new Vec3[]{point, axis.normalize()});
                              }

                              spawned++;
                           }
                        }

                        if (spawned > 0) {
                           SymbioteLog.event("CURIOSITY_FIDGET player={} tendrils={} kind={}", player.getUUID(), spawned, rain ? "rain" : "poke");
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static void tickProds(ServerLevel level) {
      if (!PRODDING.isEmpty()) {
         PRODDING.entrySet().removeIf(e -> {
            if (!(level.getEntity(e.getKey()) instanceof TendrilFxEntity fx && fx.isAlive())) {
               return true;
            } else {
               if (fx.getMantleJobStart() != 0 && fx.getMantleJobEnd() != 0 && (int)level.getGameTime() - fx.getMantleJobEnd() >= 0) {
                  return true;
               }

               Vec3 base = e.getValue()[0];
               Vec3 axis = e.getValue()[1];
               boolean press = fx.tickCount / 20 % 2 == 0;
               Vec3 tip = base.add(axis.scale(press ? 0.2 : -0.06));
               fx.setTargetPos(tip.x, tip.y, tip.z);
               return false;
            }
         });
      }
   }

   public static void noteTaste(ServerPlayer player, ServerLevel level, LivingEntity prey) {
      noteTaste(player, level, prey, true);
   }

   public static void noteTaste(ServerPlayer player, ServerLevel level, LivingEntity prey, boolean voiced) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p != null && p.stage.isBonded()) {
         String id = speciesId(prey);
         if (p.tastedSpecies.add(id)) {
            SymbioteTracker.get(level).setDirty();
            if (voiced) {
               VoiceLines.send(player, prey instanceof Villager ? "symbiote.voice.taste_villager" : "symbiote.voice.taste_new", 3);
            }

            SymbioteLog.event("CURIOSITY_TASTE player={} species={} voiced={}", player.getUUID(), id, voiced);
         }
      }
   }

   public static void noteEncounter(ServerPlayer player, ServerLevel level, String key, String voiceKey) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p != null && p.stage.isBonded()) {
         if (p.instabilityUntilTick <= level.getGameTime()) {
            if (p.encounters.add(key)) {
               SymbioteTracker.get(level).setDirty();
               VoiceLines.send(player, voiceKey, 0);
               SymbioteLog.event("CURIOSITY_ENCOUNTER player={} key={}", player.getUUID(), key);
            }
         }
      }
   }

   private static String speciesId(LivingEntity e) {
      return EntityType.getKey(e.getType()).toString();
   }

   public static void tickCleanup(ServerLevel level) {
      STARING.keySet().removeIf(id -> {
         ServerPlayer pl = level.getServer().getPlayerList().getPlayer(id);
         if (pl != null && pl.isAlive()) {
            return false;
         }

         SymbioteCuriosity.Stare st = STARING.get(id);
         if (st != null && level.getEntity(st.targetId) instanceof LivingEntity held) {
            held.setNoGravity(false);
            HeldGravityGuard.release(held);
         }

         return true;
      });
      WATCH.keySet().removeIf(id -> level.getServer().getPlayerList().getPlayer(id) == null);
      WATCH_DEST.keySet().removeIf(id -> level.getServer().getPlayerList().getPlayer(id) == null);
      PENDING_WALK.keySet().removeIf(id -> level.getServer().getPlayerList().getPlayer(id) == null);
   }

   public static void onLogout(UUID player) {
      FEAR_FRESH.remove(player);
      WATCH.remove(player);
      WATCH_DEST.remove(player);
      WATCH_HIDDEN_SINCE.remove(player);
      PENDING_WALK.remove(player);
      STARING.remove(player);
      IDLE_POS.remove(player);
      IDLE_TICKS.remove(player);
      LAST_FIDGET.remove(player);
   }

   private SymbioteCuriosity() {
   }

   private static final class Stare {
      int targetId;
      long until;
      double liftY;
   }
}
