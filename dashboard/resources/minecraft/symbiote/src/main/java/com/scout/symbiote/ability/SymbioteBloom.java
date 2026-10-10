package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.OverrideGate;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.memory.MemoryModuleType;
import net.minecraft.world.entity.ai.util.DefaultRandomPos;
import net.minecraft.world.entity.animal.IronGolem;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.monster.warden.Warden;
import net.minecraft.world.entity.npc.Villager;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class SymbioteBloom {
   public static final boolean BLOOM_ENABLED = false;
   private static final int TICK_INTERVAL = 20;
   private static final int DURATION_BASE = 80;
   private static final int DURATION_PER_STAGE = 20;
   private static final int SELF_COOLDOWN = 1200;
   private static final int SENSE_INTERVAL = 10;
   private static final int SENSE_PING_TICKS = 20;
   private static final int SENSE_RANGE = 24;
   private static final double FEAR_RANGE = 14.0;
   private static final int FEAR_TICKS = 200;
   private static final Map<UUID, Long> LAST_BLOOM = new HashMap<>();

   public static void tickActive(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (p.bloomUntilTick != 0L) {
         if (p.isBlooming(now)) {
            if (now % 10L == 0L) {
               pulseSense(player, level, p);
            }
         } else {
            close(player, level, p);
         }
      }
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (p.bloomUntilTick == 0L) {
         if (now % 20L == 0L) {
            ;
         }
      }
   }

   private static String evaluate(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      boolean wardenNear = !level.getEntitiesOfClass(Warden.class, player.getBoundingBox().inflate(20.0)).isEmpty();
      if (p.strain == SymbioteStrain.SCULK && wardenNear) {
         return null;
      } else if (player.getHealth() / player.getMaxHealth() <= 0.2F && hostileInSight(player, level)) {
         return "cornered";
      } else if (p.hunger <= 5) {
         return "starving";
      } else if (p.stress >= 75 && CombatSense.inCombat(player)) {
         return "panic";
      } else {
         return wardenNear ? "warden" : null;
      }
   }

   private static boolean hostileInSight(ServerPlayer player, ServerLevel level) {
      for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(12.0), en -> en != player && en.isAlive() && en instanceof Enemy)) {
         if (player.hasLineOfSight(e)) {
            return true;
         }
      }

      return false;
   }

   public static void force(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
   }

   private static void open(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now, String cause) {
      int duration = 80 + 20 * Math.max(0, p.stage.ordinal() - BondStage.INTEGRATED.ordinal());
      p.bloomOpenTick = now;
      p.bloomUntilTick = now + duration;
      LAST_BLOOM.put(player.getUUID(), now);
      OverrideGate.seize(player, level, p, "bloom");
      level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_ERUPT.get(), SoundSource.PLAYERS, 1.0F, 0.85F);
      ModNetwork.sendOverrideFx(player, "bloom", duration);
      VoiceLines.send(player, "symbiote.voice.bloom_" + cause, 4);
      terrify(player, level);
      pulseSenseCounted(player, level, p);
      SymbioteTracker.get(level).setDirty();
      ModNetwork.syncToPlayer(level, player);
      SymbioteLog.event("BLOOM_OPEN player={} cause={} strain={} duration={} stage={}", player.getUUID(), cause, p.strain, duration, p.stage);
   }

   private static void close(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      p.bloomOpenTick = 0L;
      p.bloomUntilTick = 0L;
      level.playSound(
         null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_RETRACT.get(), SoundSource.PLAYERS, 0.9F, 0.95F
      );
      SymbioteTracker.get(level).setDirty();
      ModNetwork.syncToPlayer(level, player);
      SymbioteLog.event("BLOOM_CLOSE player={}", player.getUUID());
   }

   public static void clear(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (p != null && p.bloomUntilTick != 0L) {
         p.bloomOpenTick = 0L;
         p.bloomUntilTick = 0L;
         if (level != null && player != null) {
            SymbioteTracker.get(level).setDirty();
            ModNetwork.syncToPlayer(level, player);
         }

         SymbioteLog.event("BLOOM_CLEARED player={}", player == null ? "null" : player.getUUID());
      }
   }

   public static void onLogout(UUID id) {
      LAST_BLOOM.remove(id);
   }

   private static void terrify(ServerPlayer player, ServerLevel level) {
      AABB box = player.getBoundingBox().inflate(14.0);

      for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, box, en -> en.isAlive() && en != player)) {
         if (e instanceof IronGolem golem) {
            golem.setTarget(player);
         } else if (e instanceof Villager villager) {
            villager.getBrain().setMemoryWithExpiry(MemoryModuleType.HURT_BY_ENTITY, player, 200L);
            flee(villager, player);
         } else if (!(e instanceof Enemy) && e instanceof PathfinderMob mob) {
            flee(mob, player);
         }
      }
   }

   private static void flee(PathfinderMob mob, ServerPlayer from) {
      Vec3 away = DefaultRandomPos.getPosAway(mob, 14, 7, from.position());
      if (away != null) {
         mob.getNavigation().moveTo(away.x, away.y, away.z, 1.35);
      }
   }

   private static void pulseSense(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      int lit = pulseSenseCounted(player, level, p);
      if ((Boolean)SymbioteConfig.VERBOSE_LOGGING.get()) {
         SymbioteLog.debug("BLOOM_SENSE player={} lit={}", player.getUUID(), lit);
      }
   }

   public static int pulseSenseCounted(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      AABB box = player.getBoundingBox().inflate(senseRange(p));
      List<LivingEntity> seen = level.getEntitiesOfClass(LivingEntity.class, box, e -> e.isAlive() && e != player);
      if (seen.isEmpty()) {
         return 0;
      }

      int[] ids = new int[seen.size()];

      for (int i = 0; i < seen.size(); i++) {
         ids[i] = seen.get(i).getId();
      }

      ModNetwork.sendSculkGlow(player, ids, 20);
      return ids.length;
   }

   private static int senseRange(SymbioteProfile p) {
      return 24 + (p.strain == SymbioteStrain.SCULK ? StrainTraits.senseRangeBonus(p.strain) : 0);
   }

   private SymbioteBloom() {
   }
}
