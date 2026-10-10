package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.RandomSource;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.boss.wither.WitherBoss;
import net.minecraft.world.entity.monster.warden.Warden;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.ProjectileUtil;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;

public final class TendrilYank {
   private static final String COOLDOWN_KEY = "tendril_yank";
   private static final double TETHER_DISTANCE = 4.5;
   private static final float THROW_POWER = 2.0F;
   private static final float THROW_DAMAGE = 4.0F;
   private static final int GRAB_LIFETIME_TICKS = 160;
   private static final double MAX_REACH_DISTANCE = 12.0;

   public static boolean haulable(LivingEntity t, Player host) {
      return host != null && host.getVehicle() == t ? false : haulable(t);
   }

   public static boolean haulable(LivingEntity t) {
      if (!(t instanceof EnderDragon) && !(t instanceof WitherBoss) && !(t instanceof Warden)) {
         float w = t.getBbWidth();
         float h = t.getBbHeight();
         return !(w > 1.6F) && !(h > 3.2F) ? w * w * h <= 3.2F : false;
      } else {
         return false;
      }
   }

   public static void fire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      long now = level.getGameTime();
      WallCling.forceRelease(player, "tendril_yank");
      if (GrabState.isHolding(player.getUUID())) {
         GrabState.Held held = GrabState.get(player.getUUID());
         if (held == null || now - held.grabStartTick >= 10L) {
            throwHeld(player, level, p);
         }
      } else {
         int cooldown = effectiveCooldown(p);
         if (now - getCooldownTickFor(p, "tendril_yank") < cooldown) {
            SymbioteLog.event("ABILITY_REJECTED ability=tendril_yank player={} reason=on_cooldown", player.getUUID());
         } else {
            double range = SymbioteConfig.TENDRIL_YANK_RANGE.get().intValue();
            Vec3 eye = player.getEyePosition();
            Vec3 look = player.getLookAngle();
            Vec3 end = eye.add(look.scale(range));
            AABB box = player.getBoundingBox().expandTowards(look.scale(range)).inflate(1.0);
            EntityHitResult hit = ProjectileUtil.getEntityHitResult(
               level,
               player,
               eye,
               end,
               box,
               e -> e instanceof LivingEntity living && e != player && e.isAlive() && !(e instanceof Player) && haulable(living, player)
            );
            if (hit != null && hit.getEntity() instanceof LivingEntity target) {
               if (!spendStamina(player, level, p)) {
                  return;
               }

               setCooldown(p, "tendril_yank", now);
               TendrilFxEntity fx = TendrilMantle.beginJob(player, level, target.position().add(0.0, target.getBbHeight() * 0.5, 0.0));
               if (fx != null) {
                  fx.setReachTicksOverride(6);
               } else {
                  fx = TendrilFxEntity.spawnGrab(level, player, target, 160, p.strain);
               }

               fx.setWrapTarget(target.getId());
               GrabState.start(player.getUUID(), target.getId(), now, fx);
               level.playSound(
                  null, target.getX(), target.getY(), target.getZ(), (SoundEvent)ModSounds.TENDRIL_GRIP.get(), SoundSource.PLAYERS, 0.6F, 1.0F
               );
               SymbioteLog.event("ABILITY_FIRED ability=tendril_yank mode=grab player={} target={}", player.getUUID(), target.getUUID());
               if (player.getRandom().nextFloat() < 0.3F) {
                  VoiceLines.send(player, "symbiote.voice.tendril_yank", 3);
               }

               ModNetwork.sendOverrideFx(player, "tendril_burst", 10);
            } else {
               List<Vec3> anchors = findLaunchAnchors(player, level, look, range);
               if (anchors.isEmpty()) {
                  SymbioteLog.event("ABILITY_REJECTED ability=tendril_yank mode=self_pull player={} reason=no_anchor", player.getUUID());
                  VoiceLines.send(player, "symbiote.voice.ability_no_grip", 0);
                  return;
               }

               if (!spendStamina(player, level, p)) {
                  return;
               }

               setCooldown(p, "tendril_yank", now);
               RandomSource random = player.getRandom();

               for (Vec3 anchor : anchors) {
                  TendrilFxEntity borrowed = TendrilMantle.timedJob(player, level, anchor, 3, 8, 2, ItemStack.EMPTY);
                  if (borrowed == null) {
                     TendrilFxEntity fx = TendrilFxEntity.spawnGrabAtPoint(level, player, anchor, 14 + random.nextInt(7), p.strain);
                     fx.setThick(true);
                     fx.setReachTicksOverride(3);
                     fx.setArc(0.2F + random.nextFloat() * 0.25F, (float)(random.nextDouble() * Math.PI * 2.0));
                  }
               }

               level.playSound(
                  null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_ERUPT.get(), SoundSource.PLAYERS, 0.8F, 1.0F
               );
               Vec3 pull = look.scale(1.4);
               player.push(pull.x, Math.max(0.3, pull.y), pull.z);
               player.hurtMarked = true;
               LeapFallProtection.tag(player.getUUID(), now);
               SymbioteLog.event("ABILITY_FIRED ability=tendril_yank mode=self_pull player={} anchors={}", player.getUUID(), anchors.size());
               ModNetwork.sendOverrideFx(player, "tendril_burst", 20);
            }
         }
      }
   }

   private static List<Vec3> findLaunchAnchors(ServerPlayer player, ServerLevel level, Vec3 look, double range) {
      Vec3 eye = player.getEyePosition();
      List<Vec3> anchors = new ArrayList<>(5);
      Vec3[] dirs = new Vec3[]{
         look,
         rotateYaw(look, Math.toRadians(25.0)),
         rotateYaw(look, Math.toRadians(-25.0)),
         pitchDown(rotateYaw(look, Math.toRadians(12.0)), Math.toRadians(30.0)),
         pitchDown(rotateYaw(look, Math.toRadians(-12.0)), Math.toRadians(30.0))
      };

      for (Vec3 dir : dirs) {
         Vec3 hitPos = raycastBlock(player, level, eye, dir, range);
         if (hitPos == null) {
            hitPos = raycastBlock(player, level, eye, pitchDown(dir, Math.toRadians(40.0)), range);
         }

         if (hitPos != null) {
            Vec3 hp = hitPos;
            boolean dupe = anchors.stream().anyMatch(ax -> ax.distanceToSqr(hp) < 0.09);
            if (!dupe) {
               anchors.add(hitPos);
            }
         }
      }

      if (!anchors.isEmpty() && anchors.size() < 5) {
         Vec3 tangent = look.cross(new Vec3(0.0, 1.0, 0.0));
         tangent = tangent.lengthSqr() < 1.0E-4 ? new Vec3(1.0, 0.0, 0.0) : tangent.normalize();
         Vec3 upT = tangent.cross(look).normalize();
         int guard = 0;

         while (anchors.size() < 5 && guard < 14) {
            Vec3 base = anchors.get(++guard % anchors.size());
            double a = guard * 2.399;
            Vec3 probe = base.add(tangent.scale(Math.cos(a) * (0.45 + 0.25 * (guard % 3))))
               .add(upT.scale(Math.sin(a) * (0.4 + 0.2 * (guard % 2))));
            Vec3 dir = probe.subtract(eye);
            if (!(dir.lengthSqr() < 1.0E-4)) {
               Vec3 hit = raycastBlock(player, level, eye, dir.normalize(), range);
               if (hit != null) {
                  Vec3 hp = hit;
                  if (anchors.stream().noneMatch(x -> x.distanceToSqr(hp) < 0.09)) {
                     anchors.add(hit);
                  }
               }
            }
         }
      }

      return anchors;
   }

   private static Vec3 raycastBlock(ServerPlayer player, ServerLevel level, Vec3 eye, Vec3 dir, double range) {
      Vec3 to = eye.add(dir.normalize().scale(range + 2.0));
      BlockHitResult blockHit = level.clip(new ClipContext(eye, to, Block.COLLIDER, Fluid.NONE, player));
      return blockHit.getType() == Type.BLOCK ? blockHit.getLocation() : null;
   }

   private static Vec3 rotateYaw(Vec3 v, double rad) {
      double cos = Math.cos(rad);
      double sin = Math.sin(rad);
      return new Vec3(v.x * cos - v.z * sin, v.y, v.x * sin + v.z * cos);
   }

   private static Vec3 pitchDown(Vec3 v, double rad) {
      double frac = rad / (Math.PI / 2);
      return new Vec3(v.x * (1.0 - frac), v.y * (1.0 - frac) - frac, v.z * (1.0 - frac)).normalize();
   }

   public static void tickGrab(ServerPlayer player, ServerLevel level) {
      GrabState.Held held = GrabState.get(player.getUUID());
      if (held != null) {
         long now = level.getGameTime();
         if (now - held.grabStartTick > 160L) {
            releaseGrab(player, level, "timeout");
         } else if (!(level.getEntity(held.targetEntityId) instanceof LivingEntity target && target.isAlive())) {
            releaseGrab(player, level, "target_gone");
         } else if (player.getVehicle() != target && target.getVehicle() != player) {
            Entity fxEnt = level.getEntity(held.tendrilFxId);
            boolean reachComplete;
            if (fxEnt instanceof TendrilFxEntity tendril && tendril.getMantleJobStart() != 0) {
               tendril.setTargetPos(target.getX(), target.getY() + target.getBbHeight() * 0.5, target.getZ());
               reachComplete = (int)now - tendril.getMantleJobStart() >= tendril.getReachTicksOverride();
            } else {
               reachComplete = !(fxEnt instanceof TendrilFxEntity tendril2 && !tendril2.isReachComplete());
            }

            if (reachComplete) {
               Vec3 anchor = player.position().add(player.getLookAngle().scale(4.5)).add(0.0, 1.0 - target.getBbHeight() * 0.5, 0.0);
               Vec3 toAnchor = anchor.subtract(target.position());
               if (toAnchor.lengthSqr() > 16.0) {
                  target.setPos(anchor.x, anchor.y, anchor.z);
                  target.setDeltaMovement(Vec3.ZERO);
               } else {
                  target.setDeltaMovement(toAnchor);
               }

               target.hurtMarked = true;
               target.fallDistance = 0.0F;
               target.setYRot((float)Math.toDegrees(Math.atan2(player.getX() - target.getX(), target.getZ() - player.getZ())));
            } else if (player.distanceTo(target) > 12.0) {
               releaseGrab(player, level, "target_escaped_during_reach");
            } else {
               target.fallDistance = 0.0F;
            }
         } else {
            releaseGrab(player, level, "host_mounted_target");
         }
      }
   }

   public static void throwHeld(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      GrabState.Held held = GrabState.get(player.getUUID());
      if (held != null) {
         if (level.getEntity(held.targetEntityId) instanceof LivingEntity target && target.isAlive()) {
            Vec3 look = player.getLookAngle();
            Vec3 launch = look.scale(2.0).add(0.0, 0.4, 0.0);
            target.setDeltaMovement(launch);
            target.hurtMarked = true;
            DamageSource src = level.damageSources().playerAttack(player);
            target.hurt(src, 4.0F);
            SymbioteLog.event("ABILITY_FIRED ability=tendril_yank mode=throw player={} target={} power={}", player.getUUID(), target.getUUID(), 2.0F);
            VoiceLines.send(player, "symbiote.voice.tendril_yank", 3);
            Entity fx = level.getEntity(held.tendrilFxId);
            if (fx != null && !TendrilMantle.handOff(level, fx)) {
               fx.discard();
            }

            GrabState.clear(player.getUUID());
         } else {
            releaseGrab(player, level, "target_gone_on_throw");
         }
      }
   }

   public static void releaseGrab(ServerPlayer player, ServerLevel level, String reason) {
      GrabState.Held held = GrabState.get(player.getUUID());
      if (held != null) {
         Entity fx = level.getEntity(held.tendrilFxId);
         if (fx != null && !TendrilMantle.handOff(level, fx)) {
            fx.discard();
         }

         GrabState.clear(player.getUUID());
         SymbioteLog.event("GRAB_RELEASED player={} reason={}", player.getUUID(), reason);
      }
   }

   private static boolean spendStamina(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (!p.trySpendStamina(SymbioteConfig.STAMINA_COST_YANK.get())) {
         SymbioteLog.event("ABILITY_REJECTED ability=tendril_yank player={} reason=exhausted stamina={}", player.getUUID(), p.stamina);
         VoiceLines.send(player, "symbiote.voice.exhausted", 4);
         return false;
      } else {
         SymbioteTracker.get(level).setDirty();
         ModNetwork.syncToPlayer(level, player);
         return true;
      }
   }

   private static long getCooldownTickFor(SymbioteProfile p, String key) {
      return p.lastYankTick;
   }

   private static void setCooldown(SymbioteProfile p, String key, long now) {
      p.lastYankTick = now;
   }

   private static int effectiveCooldown(SymbioteProfile p) {
      int base = SymbioteConfig.TENDRIL_YANK_COOLDOWN_TICKS.get();
      double mult = StrainTraits.tendrilCooldownMult(p.strain);
      return mult == 1.0 ? base : Math.max(1, (int)Math.round(base * mult));
   }

   private TendrilYank() {
   }
}
