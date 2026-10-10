package com.scout.symbiote.entity;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.registry.ModEntities;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.SymbioteLog;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.core.particles.ParticleOptions;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientGamePacketListener;
import net.minecraft.network.protocol.game.ClientboundAddEntityPacket;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.RandomSource;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Entity.RemovalReason;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public class TendrilFxEntity extends Entity {
   public static final int MODE_BURST = 0;
   public static final int MODE_GRAB = 1;
   public static final int MODE_WHIP = 2;
   private static final EntityDataAccessor<Integer> DATA_LIFETIME = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Integer> DATA_STRAIN_ORDINAL = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Float> DATA_BURST_YAW = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Integer> DATA_OWNER_ID = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Integer> DATA_TARGET_ID = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Integer> DATA_MODE = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Float> DATA_TARGET_POS_X = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Float> DATA_TARGET_POS_Y = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Float> DATA_TARGET_POS_Z = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Float> DATA_ARC_AMPLITUDE = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Float> DATA_ARC_ANGLE = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Integer> DATA_REACH_TICKS_OVERRIDE = SynchedEntityData.defineId(
      TendrilFxEntity.class, EntityDataSerializers.INT
   );
   private static final EntityDataAccessor<Integer> DATA_HOVER_PHASE_START = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Float> DATA_HOVER_BASE_ANGLE = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Integer> DATA_MANTLE_JOB_START = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Integer> DATA_MANTLE_JOB_END = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Integer> DATA_MANTLE_MOOD = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Integer> DATA_WRAP_TARGET = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Float> DATA_TRANSITION_FROM_X = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Float> DATA_TRANSITION_FROM_Y = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Float> DATA_TRANSITION_FROM_Z = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Integer> DATA_TRANSITION_START_TICK = SynchedEntityData.defineId(
      TendrilFxEntity.class, EntityDataSerializers.INT
   );
   private static final EntityDataAccessor<Boolean> DATA_USE_BACK_ORIGIN = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.BOOLEAN);
   private static final EntityDataAccessor<Integer> DATA_RETRACT_START_TICK = SynchedEntityData.defineId(
      TendrilFxEntity.class, EntityDataSerializers.INT
   );
   private static final EntityDataAccessor<ItemStack> DATA_HELD_ITEM = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.ITEM_STACK);
   private static final EntityDataAccessor<Integer> DATA_ARM_KIND = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.INT);
   private static final EntityDataAccessor<Boolean> DATA_THICK = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.BOOLEAN);
   private static final EntityDataAccessor<Float> DATA_GIRTH = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.FLOAT);
   private static final EntityDataAccessor<Boolean> DATA_SHINY = SynchedEntityData.defineId(TendrilFxEntity.class, EntityDataSerializers.BOOLEAN);
   public static final int ARM_KIND_NONE = 0;
   public static final int ARM_KIND_MINE = 1;
   public static final int ARM_KIND_MELEE = 2;
   public static final int ARM_KIND_PLACE = 3;
   public static final double HOVER_RADIUS = 1.2;
   public static final double HOVER_ORBIT_SPEED = 0.0;
   public static final double HOVER_BOB_AMP = 0.25;
   public static final double HOVER_BOB_SPEED = 0.1;
   public static final double HOVER_HEIGHT = 2.5;
   public static final int HOVER_TRANSITION_TICKS = 16;
   public static final int HOVER_RETRACT_TICKS = 16;
   private static final Map<Level, AtomicInteger> LIVE = new ConcurrentHashMap<>();
   private boolean counted;
   private static long lastCapLog;
   private static final Map<Integer, Long> LAST_STRIKE_SOUND = new HashMap<>();
   private static final Map<Integer, Long> LAST_EXTEND_SOUND = new HashMap<>();
   public static final int MANTLE_JOB_REACH_TICKS = 8;
   public static final int MANTLE_JOB_RETURN_TICKS = 8;
   public static final int MANTLE_MOOD_FIX_BIT = 8;
   private int scheduledRetractTick = -1;
   private static final Map<Integer, Long> LAST_RETRACT_SOUND = new HashMap<>();

   public TendrilFxEntity(EntityType<? extends TendrilFxEntity> type, Level level) {
      super(type, level);
      this.noPhysics = true;
      this.setNoGravity(true);
   }

   public static int perLevelCap() {
      try {
         return (Integer)SymbioteConfig.TENDRIL_CAP.get();
      } catch (IllegalStateException notLoadedYet) {
         return 220;
      }
   }

   private static int cullTarget() {
      return Math.max(20, perLevelCap() * 4 / 5);
   }

   private static TendrilFxEntity finish(Level level, TendrilFxEntity ent) {
      if (!level.isClientSide && level instanceof ServerLevel server) {
         AtomicInteger counter = LIVE.computeIfAbsent(level, k -> new AtomicInteger());
         if (counter.get() >= perLevelCap()) {
            cull(server, counter);
         }
      }

      if (level.addFreshEntity(ent) && !level.isClientSide) {
         ent.counted = true;
         LIVE.computeIfAbsent(level, k -> new AtomicInteger()).incrementAndGet();
      }

      return ent;
   }

   private static void cull(ServerLevel level, AtomicInteger counter) {
      List<TendrilFxEntity> live = new ArrayList<>();

      for (Entity e : level.getAllEntities()) {
         if (e instanceof TendrilFxEntity t && t.isAlive()) {
            live.add(t);
         }
      }

      live.sort((a, b) -> Integer.compare(b.tickCount, a.tickCount));
      int target = cullTarget();
      int over = live.size() - target;

      for (int i = 0; i < over && i < live.size(); i++) {
         live.get(i).discard();
      }

      long now = System.currentTimeMillis();
      if (now - lastCapLog > 10000L) {
         lastCapLog = now;
         SymbioteLog.event("TENDRIL_CAP_CULL level={} had={} culled={} target={}", level.dimension().location(), live.size(), Math.max(0, over), target);
      }
   }

   public void remove(RemovalReason reason) {
      if (this.counted) {
         this.counted = false;
         AtomicInteger counter = LIVE.get(this.level());
         if (counter != null && counter.decrementAndGet() <= 0) {
            LIVE.remove(this.level());
         }
      }

      super.remove(reason);
   }

   public static void spawnBurst(Level level, Player owner, int lifetimeTicks, SymbioteStrain strain) {
      spawnBurst(level, owner, lifetimeTicks, strain, false);
   }

   public static void spawnBurst(Level level, Player owner, int lifetimeTicks, SymbioteStrain strain, boolean thick) {
      RandomSource random = owner.getRandom();
      level.playSound(
         null,
         owner.getX(),
         owner.getY(),
         owner.getZ(),
         (SoundEvent)ModSounds.TENDRIL_ERUPT.get(),
         SoundSource.PLAYERS,
         0.65F,
         0.9F + random.nextFloat() * 0.2F
      );
      int count = 5 + random.nextInt(3);
      Vec3 chest = owner.position().add(0.0, 1.0, 0.0);

      for (int i = 0; i < count; i++) {
         double yaw = random.nextDouble() * Math.PI * 2.0;
         double pitch = random.nextDouble() * 1.3 - 0.3;
         double dist = 1.8 + random.nextDouble() * 1.7;
         double cosP = Math.cos(pitch);
         Vec3 tip = chest.add(Math.cos(yaw) * cosP * dist, Math.sin(pitch) * dist, Math.sin(yaw) * cosP * dist);
         int life = Math.max(10, lifetimeTicks - 4 + random.nextInt(9));
         TendrilFxEntity fx = spawnGrabAtPoint(level, owner, tip, life, strain);
         fx.setReachTicksOverride(3 + random.nextInt(3));
         fx.setArc(0.25F + random.nextFloat() * 0.35F, (float)(random.nextDouble() * Math.PI * 2.0));
         if (thick) {
            fx.setThick(true);
         }
      }
   }

   public static TendrilFxEntity spawnGrab(Level level, Player owner, LivingEntity target, int lifetimeTicks, SymbioteStrain strain) {
      TendrilFxEntity ent = new TendrilFxEntity((EntityType<? extends TendrilFxEntity>)ModEntities.TENDRIL_FX.get(), level);
      ent.moveTo(owner.getX(), owner.getY() + 1.0, owner.getZ(), owner.getYRot(), 0.0F);
      ent.setLifetime(lifetimeTicks);
      ent.setStrainOrdinal(strain.ordinal());
      ent.setBurstYaw(owner.getYRot());
      ent.setOwnerId(owner.getId());
      ent.setTargetId(target.getId());
      ent.setMode(1);
      playExtendCue(level, owner);
      return finish(level, ent);
   }

   public static TendrilFxEntity spawnGrab(Level level, LivingEntity owner, LivingEntity target, int lifetimeTicks, SymbioteStrain strain) {
      TendrilFxEntity ent = new TendrilFxEntity((EntityType<? extends TendrilFxEntity>)ModEntities.TENDRIL_FX.get(), level);
      ent.moveTo(owner.getX(), owner.getY() + 1.0, owner.getZ(), owner.getYRot(), 0.0F);
      ent.setLifetime(lifetimeTicks);
      ent.setStrainOrdinal(strain.ordinal());
      ent.setBurstYaw(owner.getYRot());
      ent.setOwnerId(owner.getId());
      ent.setTargetId(target.getId());
      ent.setMode(1);
      long gt = level.getGameTime();
      Long last = LAST_EXTEND_SOUND.get(owner.getId());
      if (last == null || gt - last >= 4L) {
         LAST_EXTEND_SOUND.put(owner.getId(), gt);
         level.playSound(
            null,
            owner.getX(),
            owner.getY(),
            owner.getZ(),
            (SoundEvent)ModSounds.TENDRIL_EXTEND.get(),
            SoundSource.HOSTILE,
            0.5F,
            0.9F + level.random.nextFloat() * 0.2F
         );
      }

      return finish(level, ent);
   }

   public static TendrilFxEntity spawnGrabFromBlock(Level level, Vec3 origin, LivingEntity target, int lifetimeTicks, SymbioteStrain strain) {
      return spawnGrabFromBlock(level, origin, target, lifetimeTicks, strain, 0.0F, 0.0F);
   }

   public static TendrilFxEntity spawnGrabFromBlock(
      Level level, Vec3 origin, LivingEntity target, int lifetimeTicks, SymbioteStrain strain, float arcAmplitude, float arcAngle
   ) {
      TendrilFxEntity ent = new TendrilFxEntity((EntityType<? extends TendrilFxEntity>)ModEntities.TENDRIL_FX.get(), level);
      ent.moveTo(origin.x, origin.y, origin.z, 0.0F, 0.0F);
      ent.setLifetime(lifetimeTicks);
      ent.setStrainOrdinal(strain.ordinal());
      ent.setBurstYaw(0.0F);
      ent.setOwnerId(0);
      ent.setTargetId(target.getId());
      ent.setMode(1);
      ent.setArc(arcAmplitude, arcAngle);
      return finish(level, ent);
   }

   public static TendrilFxEntity spawnAmbient(
      Level level, Vec3 origin, Vec3 targetPoint, int lifetimeTicks, SymbioteStrain strain, float arcAmplitude, float arcAngle
   ) {
      TendrilFxEntity ent = new TendrilFxEntity((EntityType<? extends TendrilFxEntity>)ModEntities.TENDRIL_FX.get(), level);
      ent.moveTo(origin.x, origin.y, origin.z, 0.0F, 0.0F);
      ent.setLifetime(lifetimeTicks);
      ent.setStrainOrdinal(strain.ordinal());
      ent.setBurstYaw(0.0F);
      ent.setOwnerId(0);
      ent.setTargetId(0);
      ent.setTargetPos(targetPoint.x, targetPoint.y, targetPoint.z);
      ent.setMode(1);
      ent.setArc(arcAmplitude, arcAngle);
      level.playSound(
         null,
         origin.x,
         origin.y,
         origin.z,
         (SoundEvent)ModSounds.TENDRIL_EXTEND.get(),
         SoundSource.BLOCKS,
         0.25F,
         0.8F + level.random.nextFloat() * 0.2F
      );
      return finish(level, ent);
   }

   public static TendrilFxEntity spawnGrabAtPoint(Level level, Player owner, Vec3 targetPos, int lifetimeTicks, SymbioteStrain strain) {
      TendrilFxEntity ent = new TendrilFxEntity((EntityType<? extends TendrilFxEntity>)ModEntities.TENDRIL_FX.get(), level);
      ent.moveTo(owner.getX(), owner.getY() + 1.0, owner.getZ(), owner.getYRot(), 0.0F);
      ent.setLifetime(lifetimeTicks);
      ent.setStrainOrdinal(strain.ordinal());
      ent.setBurstYaw(owner.getYRot());
      ent.setOwnerId(owner.getId());
      ent.setTargetId(0);
      ent.setMode(1);
      ent.setTargetPos(targetPos.x, targetPos.y, targetPos.z);
      playExtendCue(level, owner);
      return finish(level, ent);
   }

   public static TendrilFxEntity spawnArm(
      Level level, Player owner, Vec3 targetPos, int lifetimeTicks, SymbioteStrain strain, int armKind, int reachOverride, float hoverAngle, ItemStack held
   ) {
      TendrilFxEntity ent = new TendrilFxEntity((EntityType<? extends TendrilFxEntity>)ModEntities.TENDRIL_FX.get(), level);
      ent.moveTo(owner.getX(), owner.getY() + 1.0, owner.getZ(), owner.getYRot(), 0.0F);
      ent.setLifetime(lifetimeTicks);
      ent.setStrainOrdinal(strain.ordinal());
      ent.setBurstYaw(owner.getYRot());
      ent.setOwnerId(owner.getId());
      ent.setTargetId(0);
      ent.setMode(1);
      ent.setTargetPos(targetPos.x, targetPos.y, targetPos.z);
      ent.setUseBackOrigin(true);
      ent.setReachTicksOverride(reachOverride);
      ent.setArmKind(armKind);
      ent.setHoverBaseAngle(hoverAngle);
      ent.setHeldItem(held == null ? ItemStack.EMPTY : held);
      playExtendCue(level, owner);
      return finish(level, ent);
   }

   public static TendrilFxEntity spawnMantleTendril(Level level, Player owner, int lifetimeTicks, SymbioteStrain strain, float baseAngle) {
      TendrilFxEntity ent = spawnCrownTendril(level, owner, lifetimeTicks, strain, baseAngle);
      ent.setShiny(false);
      return ent;
   }

   public static TendrilFxEntity spawnCrownTendril(Level level, Player owner, int lifetimeTicks, SymbioteStrain strain, float baseAngle) {
      TendrilFxEntity ent = new TendrilFxEntity((EntityType<? extends TendrilFxEntity>)ModEntities.TENDRIL_FX.get(), level);
      ent.moveTo(owner.getX(), owner.getY() + 1.0, owner.getZ(), owner.getYRot(), 0.0F);
      ent.setLifetime(lifetimeTicks);
      ent.setStrainOrdinal(strain.ordinal());
      ent.setBurstYaw(owner.getYRot());
      ent.setOwnerId(owner.getId());
      ent.setTargetId(0);
      ent.setMode(1);
      ent.setTargetPos(owner.getX(), owner.getY() + 2.0, owner.getZ());
      ent.setUseBackOrigin(true);
      ent.setReachTicksOverride(10);
      ent.setArmKind(2);
      ent.setHoverBaseAngle(baseAngle);
      ent.setHoverPhaseStart(1);
      ent.setShiny(true);
      playExtendCue(level, owner);
      return finish(level, ent);
   }

   public static TendrilFxEntity spawnWhip(Level level, Player owner, LivingEntity target, int lifetimeTicks, SymbioteStrain strain) {
      return spawnWhip(level, owner, target, lifetimeTicks, strain, false);
   }

   public static TendrilFxEntity spawnWhip(Level level, Player owner, LivingEntity target, int lifetimeTicks, SymbioteStrain strain, boolean shiny) {
      TendrilFxEntity ent = new TendrilFxEntity((EntityType<? extends TendrilFxEntity>)ModEntities.TENDRIL_FX.get(), level);
      ent.moveTo(owner.getX(), owner.getY() + 1.0, owner.getZ(), owner.getYRot(), 0.0F);
      ent.setLifetime(lifetimeTicks);
      ent.setStrainOrdinal(strain.ordinal());
      ent.setBurstYaw(owner.getYRot());
      ent.setOwnerId(owner.getId());
      ent.setTargetId(target.getId());
      ent.setMode(2);
      ent.setShiny(shiny);
      ent.setTargetPos(target.getX(), target.getY() + target.getBbHeight() * 0.5, target.getZ());
      long gt = level.getGameTime();
      Long lastSnd = LAST_STRIKE_SOUND.get(owner.getId());
      if (lastSnd == null || gt - lastSnd >= 2L) {
         LAST_STRIKE_SOUND.put(owner.getId(), gt);
         level.playSound(
            null,
            owner.getX(),
            owner.getY(),
            owner.getZ(),
            (SoundEvent)ModSounds.TENDRIL_STRIKE.get(),
            SoundSource.PLAYERS,
            0.5F,
            0.9F + owner.getRandom().nextFloat() * 0.25F
         );
      }

      return finish(level, ent);
   }

   private static void playExtendCue(Level level, Player owner) {
      long gt = level.getGameTime();
      Long last = LAST_EXTEND_SOUND.get(owner.getId());
      if (last == null || gt - last >= 4L) {
         LAST_EXTEND_SOUND.put(owner.getId(), gt);
         level.playSound(
            null,
            owner.getX(),
            owner.getY(),
            owner.getZ(),
            (SoundEvent)ModSounds.TENDRIL_EXTEND.get(),
            SoundSource.PLAYERS,
            0.4F,
            0.9F + owner.getRandom().nextFloat() * 0.2F
         );
      }
   }

   public static TendrilFxEntity spawnWhip(Level level, LivingEntity owner, LivingEntity target, int lifetimeTicks, SymbioteStrain strain) {
      TendrilFxEntity ent = new TendrilFxEntity((EntityType<? extends TendrilFxEntity>)ModEntities.TENDRIL_FX.get(), level);
      ent.moveTo(owner.getX(), owner.getY() + 1.0, owner.getZ(), owner.getYRot(), 0.0F);
      ent.setLifetime(lifetimeTicks);
      ent.setStrainOrdinal(strain.ordinal());
      ent.setBurstYaw(owner.getYRot());
      ent.setOwnerId(owner.getId());
      ent.setTargetId(target.getId());
      ent.setMode(2);
      ent.setTargetPos(target.getX(), target.getY() + target.getBbHeight() * 0.5, target.getZ());
      long gt = level.getGameTime();
      Long lastSnd = LAST_STRIKE_SOUND.get(owner.getId());
      if (lastSnd == null || gt - lastSnd >= 2L) {
         LAST_STRIKE_SOUND.put(owner.getId(), gt);
         level.playSound(
            null,
            owner.getX(),
            owner.getY(),
            owner.getZ(),
            (SoundEvent)ModSounds.TENDRIL_STRIKE.get(),
            SoundSource.PLAYERS,
            0.5F,
            0.9F + owner.getRandom().nextFloat() * 0.25F
         );
      }

      return finish(level, ent);
   }

   @Override
   protected void defineSynchedData(SynchedEntityData.Builder builder) {
      builder.define(DATA_LIFETIME, 20);
      builder.define(DATA_STRAIN_ORDINAL, 0);
      builder.define(DATA_BURST_YAW, 0.0F);
      builder.define(DATA_OWNER_ID, 0);
      builder.define(DATA_TARGET_ID, 0);
      builder.define(DATA_MODE, 0);
      builder.define(DATA_TARGET_POS_X, 0.0F);
      builder.define(DATA_TARGET_POS_Y, 0.0F);
      builder.define(DATA_TARGET_POS_Z, 0.0F);
      builder.define(DATA_ARC_AMPLITUDE, 0.0F);
      builder.define(DATA_ARC_ANGLE, 0.0F);
      builder.define(DATA_REACH_TICKS_OVERRIDE, 0);
      builder.define(DATA_HOVER_PHASE_START, 0);
      builder.define(DATA_HOVER_BASE_ANGLE, 0.0F);
      builder.define(DATA_MANTLE_JOB_START, 0);
      builder.define(DATA_MANTLE_JOB_END, 0);
      builder.define(DATA_MANTLE_MOOD, 0);
      builder.define(DATA_WRAP_TARGET, 0);
      builder.define(DATA_TRANSITION_FROM_X, 0.0F);
      builder.define(DATA_TRANSITION_FROM_Y, 0.0F);
      builder.define(DATA_TRANSITION_FROM_Z, 0.0F);
      builder.define(DATA_TRANSITION_START_TICK, 0);
      builder.define(DATA_USE_BACK_ORIGIN, false);
      builder.define(DATA_RETRACT_START_TICK, 0);
      builder.define(DATA_HELD_ITEM, ItemStack.EMPTY);
      builder.define(DATA_ARM_KIND, 0);
      builder.define(DATA_THICK, false);
      builder.define(DATA_GIRTH, 1.0F);
      builder.define(DATA_SHINY, false);
   }

   public boolean shouldBeSaved() {
      return false;
   }

   public void tick() {
      super.tick();
      if (!this.level().isClientSide && this.scheduledRetractTick > 0 && this.tickCount >= this.scheduledRetractTick && this.getRetractStartTick() <= 0) {
         if (this.usesBackOrigin() && this.getHoverPhaseStart() > 0) {
            SymbioteLog.event(
               "MANTLE_LIMB_EXPIRED fx={} owner={} tick={} sched={} life={}",
               this.getId(),
               this.getOwnerId(),
               this.tickCount,
               this.scheduledRetractTick,
               this.getLifetime()
            );
         }

         Vec3 tip = this.getTargetPos();
         this.setTransitionFrom(tip.x, tip.y, tip.z, this.tickCount);
         this.setRetractStartTick(this.tickCount);
         this.scheduledRetractTick = -1;
      }

      Entity owner = this.getOwner();
      if (owner != null) {
         Vec3 anchor = computeAnchorWorld(owner);
         this.moveTo(anchor.x, anchor.y, anchor.z, owner.getYRot(), 0.0F);
      }

      if (this.level().isClientSide && this.getMode() == 1 && this.tickCount % 4 == 0) {
         this.spawnChainParticles();
      }

      int life = (Integer)this.entityData.get(DATA_LIFETIME);
      boolean retractWillFire = this.scheduledRetractTick >= 0 && this.scheduledRetractTick <= life - 16;
      if (!this.level().isClientSide && this.getRetractStartTick() <= 0 && !retractWillFire && this.tickCount >= life - 16) {
         Vec3 tip = this.getTargetPos();
         this.setTransitionFrom(tip.x, tip.y, tip.z, this.tickCount);
         this.setRetractStartTick(this.tickCount);
         if ((Boolean)SymbioteConfig.VERBOSE_LOGGING.get()) {
            SymbioteLog.event("TENDRIL_EOL_RETRACT id={} owner={} life={}", this.getId(), this.getOwnerId(), life);
         }

         life = (Integer)this.entityData.get(DATA_LIFETIME);
      }

      if (this.tickCount >= life && !this.level().isClientSide) {
         this.discard();
      }
   }

   public static Vec3 computeAnchorWorld(Entity owner) {
      return new Vec3(owner.getX(), owner.getY() + 1.0, owner.getZ());
   }

   private void spawnChainParticles() {
      Entity owner = this.getOwner();
      Entity target = this.getTarget();
      if (owner != null && target != null) {
         Vec3 anchor = computeAnchorWorld(owner);
         double ox = anchor.x;
         double oy = anchor.y;
         double oz = anchor.z;
         double tx = target.getX();
         double ty = target.getY() + target.getBbHeight() * 0.5;
         double tz = target.getZ();
         Vec3 forward = new Vec3(tx - ox, ty - oy, tz - oz);
         if (!(forward.lengthSqr() < 1.0E-4)) {
            Vec3 forwardN = forward.normalize();
            Vec3 worldUp = new Vec3(0.0, 1.0, 0.0);
            Vec3 right;
            if (Math.abs(forwardN.dot(worldUp)) > 0.99) {
               right = new Vec3(1.0, 0.0, 0.0).cross(forwardN).normalize();
            } else {
               right = forwardN.cross(worldUp).normalize();
            }

            Vec3 up = right.cross(forwardN).normalize();
            ParticleOptions wisp = ParticleTypes.SMOKE;
            ParticleOptions drip = ParticleTypes.FALLING_OBSIDIAN_TEAR;
            double frac = this.pickEndBiasedFrac();
            double radialOffset = 0.28;
            double angle = this.random.nextDouble() * 2.0 * Math.PI;
            double offX = (right.x * Math.cos(angle) + up.x * Math.sin(angle)) * radialOffset;
            double offY = (right.y * Math.cos(angle) + up.y * Math.sin(angle)) * radialOffset;
            double offZ = (right.z * Math.cos(angle) + up.z * Math.sin(angle)) * radialOffset;
            double px = ox + (tx - ox) * frac + offX;
            double py = oy + (ty - oy) * frac + offY;
            double pz = oz + (tz - oz) * frac + offZ;
            double vx = (this.random.nextDouble() - 0.5) * 0.02;
            double vy = (this.random.nextDouble() - 0.5) * 0.02;
            double vz = (this.random.nextDouble() - 0.5) * 0.02;
            this.level().addParticle(wisp, px, py, pz, vx, vy, vz);
            if (this.random.nextFloat() < 0.35F) {
               double frac2 = this.pickEndBiasedFrac();
               double angle2 = this.random.nextDouble() * 2.0 * Math.PI;
               double off2X = (right.x * Math.cos(angle2) + up.x * Math.sin(angle2)) * 0.2;
               double off2Y = (right.y * Math.cos(angle2) + up.y * Math.sin(angle2)) * 0.2;
               double off2Z = (right.z * Math.cos(angle2) + up.z * Math.sin(angle2)) * 0.2;
               double dpx = ox + (tx - ox) * frac2 + off2X;
               double dpy = oy + (ty - oy) * frac2 + off2Y;
               double dpz = oz + (tz - oz) * frac2 + off2Z;
               this.level().addParticle(drip, dpx, dpy, dpz, 0.0, 0.0, 0.0);
            }
         }
      }
   }

   private double pickEndBiasedFrac() {
      double r = this.random.nextDouble();
      double centered = (r - 0.5) * 2.0;
      double biased = Math.signum(centered) * Math.sqrt(Math.abs(centered));
      return 0.5 + biased * 0.5;
   }

   public int getLifetime() {
      return (Integer)this.entityData.get(DATA_LIFETIME);
   }

   public void setLifetime(int t) {
      this.entityData.set(DATA_LIFETIME, t);
   }

   public SymbioteStrain getStrain() {
      return SymbioteStrain.fromOrdinalSafe((Integer)this.entityData.get(DATA_STRAIN_ORDINAL));
   }

   public void setStrainOrdinal(int o) {
      this.entityData.set(DATA_STRAIN_ORDINAL, o);
   }

   public float getBurstYaw() {
      return (Float)this.entityData.get(DATA_BURST_YAW);
   }

   public void setBurstYaw(float y) {
      this.entityData.set(DATA_BURST_YAW, y);
   }

   public int getOwnerId() {
      return (Integer)this.entityData.get(DATA_OWNER_ID);
   }

   public void setOwnerId(int id) {
      this.entityData.set(DATA_OWNER_ID, id);
   }

   public int getTargetId() {
      return (Integer)this.entityData.get(DATA_TARGET_ID);
   }

   public void setTargetId(int id) {
      this.entityData.set(DATA_TARGET_ID, id);
   }

   public int getMode() {
      return (Integer)this.entityData.get(DATA_MODE);
   }

   public void setMode(int m) {
      this.entityData.set(DATA_MODE, m);
   }

   public void setTargetPos(double x, double y, double z) {
      this.entityData.set(DATA_TARGET_POS_X, (float)x);
      this.entityData.set(DATA_TARGET_POS_Y, (float)y);
      this.entityData.set(DATA_TARGET_POS_Z, (float)z);
   }

   public Vec3 getTargetPos() {
      return new Vec3(
         ((Float)this.entityData.get(DATA_TARGET_POS_X)).floatValue(),
         ((Float)this.entityData.get(DATA_TARGET_POS_Y)).floatValue(),
         ((Float)this.entityData.get(DATA_TARGET_POS_Z)).floatValue()
      );
   }

   public void setArc(float amplitude, float angle) {
      this.entityData.set(DATA_ARC_AMPLITUDE, amplitude);
      this.entityData.set(DATA_ARC_ANGLE, angle);
   }

   public float getArcAmplitude() {
      return (Float)this.entityData.get(DATA_ARC_AMPLITUDE);
   }

   public float getArcAngle() {
      return (Float)this.entityData.get(DATA_ARC_ANGLE);
   }

   public void setReachTicksOverride(int ticks) {
      this.entityData.set(DATA_REACH_TICKS_OVERRIDE, ticks);
   }

   public int getReachTicksOverride() {
      return (Integer)this.entityData.get(DATA_REACH_TICKS_OVERRIDE);
   }

   public void setHoverPhaseStart(int tick) {
      this.entityData.set(DATA_HOVER_PHASE_START, tick);
   }

   public int getHoverPhaseStart() {
      return (Integer)this.entityData.get(DATA_HOVER_PHASE_START);
   }

   public void beginMantleJob(Vec3 target, long gameTime) {
      this.setTargetPos(target.x, target.y, target.z);
      this.entityData.set(DATA_MANTLE_JOB_START, (int)gameTime);
      this.entityData.set(DATA_MANTLE_JOB_END, 0);
   }

   public void endMantleJob(long gameTime) {
      this.entityData.set(DATA_MANTLE_JOB_END, (int)gameTime);
   }

   public void clearMantleJob() {
      this.entityData.set(DATA_MANTLE_JOB_START, 0);
      this.entityData.set(DATA_MANTLE_JOB_END, 0);
   }

   public int getMantleJobStart() {
      return (Integer)this.entityData.get(DATA_MANTLE_JOB_START);
   }

   public int getMantleJobEnd() {
      return (Integer)this.entityData.get(DATA_MANTLE_JOB_END);
   }

   public void setMantleMood(int packed) {
      this.entityData.set(DATA_MANTLE_MOOD, packed);
   }

   public int getMantleMood() {
      return (Integer)this.entityData.get(DATA_MANTLE_MOOD);
   }

   public void setWrapTarget(int entityId) {
      this.entityData.set(DATA_WRAP_TARGET, entityId);
   }

   public int getWrapTarget() {
      return (Integer)this.entityData.get(DATA_WRAP_TARGET);
   }

   public void setHoverBaseAngle(float angle) {
      this.entityData.set(DATA_HOVER_BASE_ANGLE, angle);
   }

   public float getHoverBaseAngle() {
      return (Float)this.entityData.get(DATA_HOVER_BASE_ANGLE);
   }

   public void scheduleRetract(int atTickCount) {
      this.scheduledRetractTick = atTickCount;
   }

   public int getScheduledRetractTick() {
      return this.scheduledRetractTick;
   }

   public void setTransitionFrom(double x, double y, double z, int startTick) {
      this.entityData.set(DATA_TRANSITION_FROM_X, (float)x);
      this.entityData.set(DATA_TRANSITION_FROM_Y, (float)y);
      this.entityData.set(DATA_TRANSITION_FROM_Z, (float)z);
      this.entityData.set(DATA_TRANSITION_START_TICK, startTick);
   }

   public Vec3 getTransitionFrom() {
      return new Vec3(
         ((Float)this.entityData.get(DATA_TRANSITION_FROM_X)).floatValue(),
         ((Float)this.entityData.get(DATA_TRANSITION_FROM_Y)).floatValue(),
         ((Float)this.entityData.get(DATA_TRANSITION_FROM_Z)).floatValue()
      );
   }

   public int getTransitionStartTick() {
      return (Integer)this.entityData.get(DATA_TRANSITION_START_TICK);
   }

   public void setUseBackOrigin(boolean back) {
      this.entityData.set(DATA_USE_BACK_ORIGIN, back);
   }

   public boolean usesBackOrigin() {
      return (Boolean)this.entityData.get(DATA_USE_BACK_ORIGIN);
   }

   @Override
   public boolean hurtServer(ServerLevel level, DamageSource source, float amount) {
      return false;
   }

   public boolean fireImmune() {
      return true;
   }

   public void setRetractStartTick(int tick) {
      this.entityData.set(DATA_RETRACT_START_TICK, tick);
      if (tick > 0 && !this.level().isClientSide && this.getLifetime() < tick + 16 + 2) {
         this.setLifetime(tick + 16 + 2);
      }

      if (tick > 0 && !this.level().isClientSide && this.getOwner() instanceof Player owner) {
         long gt = this.level().getGameTime();
         Long last = LAST_RETRACT_SOUND.get(owner.getId());
         if (last == null || gt - last >= 4L) {
            LAST_RETRACT_SOUND.put(owner.getId(), gt);
            this.level()
               .playSound(
                  null,
                  owner.getX(),
                  owner.getY(),
                  owner.getZ(),
                  (SoundEvent)ModSounds.TENDRIL_RETRACT.get(),
                  SoundSource.PLAYERS,
                  0.5F,
                  0.9F + owner.getRandom().nextFloat() * 0.2F
               );
         }
      }
   }

   public int getRetractStartTick() {
      return (Integer)this.entityData.get(DATA_RETRACT_START_TICK);
   }

   public void setHeldItem(ItemStack stack) {
      this.entityData.set(DATA_HELD_ITEM, stack == null ? ItemStack.EMPTY : stack);
   }

   public ItemStack getHeldItem() {
      return (ItemStack)this.entityData.get(DATA_HELD_ITEM);
   }

   public void setArmKind(int kind) {
      this.entityData.set(DATA_ARM_KIND, kind);
   }

   public int getArmKind() {
      return (Integer)this.entityData.get(DATA_ARM_KIND);
   }

   public void setThick(boolean thick) {
      this.entityData.set(DATA_THICK, thick);
   }

   public boolean isThick() {
      return (Boolean)this.entityData.get(DATA_THICK);
   }

   public void setGirth(float girth) {
      this.entityData.set(DATA_GIRTH, girth);
   }

   public float getGirth() {
      return (Float)this.entityData.get(DATA_GIRTH);
   }

   public void setShiny(boolean shiny) {
      this.entityData.set(DATA_SHINY, shiny);
   }

   public boolean isShiny() {
      return (Boolean)this.entityData.get(DATA_SHINY);
   }

   public Entity getOwner() {
      int id = this.getOwnerId();
      return id == 0 ? null : this.level().getEntity(id);
   }

   public Entity getTarget() {
      int id = this.getTargetId();
      return id == 0 ? null : this.level().getEntity(id);
   }

   public float getProgress(float partialTick) {
      float life = Math.max(1, (Integer)this.entityData.get(DATA_LIFETIME));
      return Math.min(1.0F, (this.tickCount + partialTick) / life);
   }

   public boolean isReachComplete() {
      int life = Math.max(1, (Integer)this.entityData.get(DATA_LIFETIME));
      return this.tickCount >= life * 0.25F;
   }

   public AABB getBoundingBoxForCulling() {
      return this.getBoundingBox().inflate(16.0);
   }

   public boolean shouldRenderAtSqrDistance(double distSq) {
      return distSq < 4096.0;
   }

   protected void readAdditionalSaveData(CompoundTag tag) {
   }

   protected void addAdditionalSaveData(CompoundTag tag) {
   }

}
