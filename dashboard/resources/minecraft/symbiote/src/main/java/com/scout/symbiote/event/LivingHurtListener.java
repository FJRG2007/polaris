package com.scout.symbiote.event;

import com.scout.symbiote.ability.ArmInstincts;
import com.scout.symbiote.ability.EmergencyRegen;
import com.scout.symbiote.ability.LeapFallProtection;
import com.scout.symbiote.ability.LivingArmor;
import com.scout.symbiote.ability.RupturePounceScene;
import com.scout.symbiote.ability.SymbioteArmsController;
import com.scout.symbiote.ability.SymbioteCuriosity;
import com.scout.symbiote.ability.TendrilMantle;
import com.scout.symbiote.ability.VoidFarewell;
import com.scout.symbiote.ability.WalkSeizure;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.entity.WildHost;
import com.scout.symbiote.failure.LastResortRevival;
import com.scout.symbiote.override.HazardReflexes;
import com.scout.symbiote.override.HungerOverride;
import com.scout.symbiote.override.OverrideGate;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.BodyControl;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.HealthGuard;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.tags.DamageTypeTags;
import net.minecraft.util.RandomSource;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.damagesource.DamageTypes;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.AbstractArrow;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.event.entity.ProjectileImpactEvent;
import net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent;
import net.neoforged.neoforge.event.entity.living.LivingKnockBackEvent;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;

public class LivingHurtListener {
   private static final Map<UUID, Long> RIVAL_REFLEX_LAST = new HashMap<>();
   private static final Map<UUID, Long> MANTLE_RETALIATE_LAST = new HashMap<>();
   private static final int CATCH_HUNGER_COST = 10;
   private static final int CATCH_STRESS = 10;
   private static final Map<UUID, Long> CARELESS_LAST = new HashMap<>();

   public static void onLogout(UUID id) {
      RIVAL_REFLEX_LAST.remove(id);
      MANTLE_RETALIATE_LAST.remove(id);
   }

   public static boolean fallDamageImmune(ServerPlayer player, SymbioteProfile p, long now) {
      return p.livingArmorActive || LeapFallProtection.isProtected(player.getUUID(), now) || BodyControl.fallProtected(player.getUUID(), now, 100);
   }

   @SubscribeEvent
   public void onProjectileImpact(ProjectileImpactEvent event) {
      if (event.getProjectile() instanceof AbstractArrow arrow) {
         if (!arrow.level().isClientSide) {
            if (event.getRayTraceResult() instanceof EntityHitResult ehr) {
               if (ehr.getEntity() instanceof ServerPlayer player) {
                  if (arrow.getOwner() != player) {
                     ServerLevel level = player.serverLevel();
                     SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
                     if (p != null && p.stage.isBonded() && p.livingArmorActive) {
                        if (p.hunger > 5) {
                           event.setCanceled(true);
                           Vec3 v = arrow.getDeltaMovement();
                           Vec3 n = arrow.position().subtract(player.position().add(0.0, player.getBbHeight() * 0.5, 0.0));
                           n = n.lengthSqr() < 1.0E-4 ? new Vec3(0.0, 1.0, 0.0) : n.normalize();
                           Vec3 out = v.subtract(n.scale(2.0 * v.dot(n)));
                           RandomSource r = level.random;
                           arrow.setDeltaMovement(out.scale(0.3).add((r.nextDouble() - 0.5) * 0.25, r.nextDouble() * 0.15, (r.nextDouble() - 0.5) * 0.25));
                           arrow.setCritArrow(false);
                           arrow.setBaseDamage(arrow.getBaseDamage() * 0.3);
                           arrow.hurtMarked = true;
                           SymbioteTracker.adjustHunger(level, player, -1, "armor_arrow_bounce");
                           level.playSound(
                              null,
                              player.getX(),
                              player.getY() + 1.0,
                              player.getZ(),
                              (SoundEvent)ModSounds.ARROW_DEFLECT.get(),
                              SoundSource.PLAYERS,
                              0.9F,
                              1.0F
                           );
                           SymbioteLog.event("LIVING_ARMOR_ARROW_BOUNCE player={} arrow={}", player.getUUID(), arrow.getType());
                        }
                     }
                  }
               }
            }
         }
      }
   }

   @SubscribeEvent(priority = EventPriority.HIGH)
   public void onLivingHurt(LivingIncomingDamageEvent event) {
      if (!(event.getEntity() instanceof Player)) {
         HealthGuard.repairAndLog(event.getEntity());
      }

      if (event.getEntity() instanceof ServerPlayer player) {
         ServerLevel level = player.serverLevel();
         SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
         if (p != null && p.stage.isBonded()) {
            DamageSource src = event.getSource();
            if (src.getEntity() instanceof LivingEntity && src.getEntity() != player) {
               WalkSeizure.notifyHostAttacked(player.getUUID());
               CombatSense.note(player);
               CombatSense.noteAggressor(player, (LivingEntity)src.getEntity());
               if (HungerOverride.isStalking(player.getUUID())) {
                  event.setAmount(event.getAmount() * 0.7F);
               }

               if (event.getAmount() >= 6.0F && src.getEntity() instanceof LivingEntity att && !(att instanceof ServerPlayer)) {
                  String species = EntityType.getKey(att.getType()).toString();
                  SymbioteCuriosity.noteFearFresh(player.getUUID(), species, att.level().getGameTime());
                  SymbioteCuriosity.noteSeenCombat(player, level, att);
                  if (!p.fearedSpecies.contains(species)) {
                     p.addFearedSpecies(species);
                     p.addBeat(MoodEngine.BeatType.SPECIES_HURT, level.getGameTime(), species);
                     SymbioteTracker.get(level).setDirty();
                     SymbioteLog.event("AVERSION_LEARNED player={} species={} dmg={}", player.getUUID(), species, event.getAmount());
                  }
               }
            }

            if (src.is(DamageTypes.IN_WALL)) {
               HazardReflexes.onSuffocation(player, level);
            }

            float amount = event.getAmount();
            long now = level.getGameTime();
            if (src.is(DamageTypes.FELL_OUT_OF_WORLD)) {
               VoidFarewell.onVoidFall(player, level, p);
            }

            if (src.is(DamageTypeTags.IS_FALL) && LeapFallProtection.consume(player.getUUID(), now)) {
               SymbioteLog.event("FALL_PROTECTION_CONSUMED player={} absorbed={}", player.getUUID(), amount);
               event.setCanceled(true);
            } else if (src.is(DamageTypeTags.IS_FALL) && BodyControl.fallProtected(player.getUUID(), now, 100)) {
               SymbioteLog.event("FALL_PROTECTED_TAKEOVER player={} absorbed={}", player.getUUID(), amount);
               event.setCanceled(true);
            } else {
               if (p.livingArmorActive) {
                  if (src.is(DamageTypeTags.IS_FALL)) {
                     SymbioteLog.event("LIVING_ARMOR_FALL_NEGATED player={} absorbed={}", player.getUUID(), amount);
                     event.setCanceled(true);
                     return;
                  }

                  if (src.is(DamageTypeTags.IS_PROJECTILE)) {
                     SymbioteLog.event("LIVING_ARMOR_PROJECTILE_NEGATED player={} absorbed={}", player.getUUID(), amount);
                     event.setCanceled(true);
                     return;
                  }

                  float reduced = LivingArmor.consume(p, amount);
                  if (reduced != amount) {
                     SymbioteLog.event("LIVING_ARMOR_ABSORBED player={} before={} after={}", player.getUUID(), amount, reduced);
                     event.setAmount(reduced);
                     amount = reduced;
                  }

                  double capFrac = StrainTraits.hitCapFrac(p.strain);
                  if (capFrac > 0.0) {
                     float cap = player.getMaxHealth() * (float)capFrac;
                     if (amount > cap) {
                        SymbioteLog.event("LIVING_ARMOR_BULWARK_CATCH player={} before={} capped={}", player.getUUID(), amount, cap);
                        event.setAmount(cap);
                        amount = cap;
                        SymbioteTracker.adjustHunger(level, player, -10, "bulwark_catch");
                        SymbioteTracker.adjustStress(level, player, 10, "bulwark_catch");
                        VoiceLines.send(player, "symbiote.voice.armor_assert", 3);
                     }
                  }

                  if (src.getEntity() instanceof LivingEntity attacker && attacker != player && attacker.distanceToSqr(player) <= 16.0) {
                     if (TendrilMantle.strike(player, level, attacker.position().add(0.0, attacker.getBbHeight() * 0.5, 0.0)) == null) {
                        TendrilFxEntity.spawnWhip(level, player, attacker, 12, p.strain);
                     }

                     attacker.hurt(
                        level.damageSources().thorns(player), SymbioteConfig.LIVING_ARMOR_THORNS_DAMAGE.get().floatValue() * (float)p.stageIntensity()
                     );
                  }
               }

               if (src.is(DamageTypeTags.IS_FALL) && amount >= 5.0F && player.getHealth() - amount > 0.0F) {
                  VoiceLines.send(player, "symbiote.voice.fall_hurt", 4);
                  SymbioteLog.event("FALL_HURT_LINE player={} damage={}", player.getUUID(), amount);
               }

               if (!p.livingArmorActive
                  && TendrilMantle.isDeployed(level, player.getUUID())
                  && src.getEntity() instanceof LivingEntity mAttacker
                  && mAttacker != player
                  && mAttacker.distanceToSqr(player) <= 16.0
                  && player.hasLineOfSight(mAttacker)
                  && now - MANTLE_RETALIATE_LAST.getOrDefault(player.getUUID(), -4611686018427387904L) > 40L
                  && player.getRandom().nextDouble() < 0.35 * p.stageIntensity() * SymbioteArmsController.retaliateAggression(p.strain)) {
                  MANTLE_RETALIATE_LAST.put(player.getUUID(), now);
                  if (TendrilMantle.strike(player, level, mAttacker.position().add(0.0, mAttacker.getBbHeight() * 0.5, 0.0)) == null) {
                     TendrilFxEntity.spawnWhip(level, player, mAttacker, 12, p.strain);
                  }

                  mAttacker.hurt(level.damageSources().thorns(player), 2.0F * (float)p.stageIntensity());
                  SymbioteLog.event("MANTLE_RETALIATE player={} attacker={}", player.getUUID(), mAttacker.getType());
               }

               if (src.getEntity() instanceof LivingEntity rival
                  && rival != player
                  && WildHost.isInfected(rival)
                  && rival.distanceToSqr(player) <= 36.0
                  && now - RIVAL_REFLEX_LAST.getOrDefault(player.getUUID(), -4611686018427387904L)
                     > (TendrilMantle.isDeployed(level, player.getUUID()) ? 15 : 25)) {
                  RIVAL_REFLEX_LAST.put(player.getUUID(), now);
                  Vec3 chest = rival.position().add(0.0, rival.getBbHeight() * 0.5, 0.0);
                  if (TendrilMantle.strike(player, level, chest) == null) {
                     TendrilFxEntity.spawnWhip(level, player, rival, 12, p.strain);
                  }

                  if (player.getRandom().nextFloat() < 0.5F) {
                     Vec3 chest2 = chest.add(player.getRandom().nextGaussian() * 0.4, 0.3, player.getRandom().nextGaussian() * 0.4);
                     if (TendrilMantle.strike(player, level, chest2) == null) {
                        TendrilFxEntity.spawnWhip(level, player, rival, 12, p.strain);
                     }
                  }

                  rival.hurt(level.damageSources().playerAttack(player), 5.0F * (float)p.stageIntensity());
                  SymbioteLog.event("RIVAL_REFLEX player={} rival={}", player.getUUID(), rival.getType());
               }

               if (p.isAegis(now)) {
                  if (src.is(DamageTypeTags.IS_PROJECTILE)) {
                     SymbioteLog.event("AEGIS_REFLECT player={} damage={}", player.getUUID(), amount);
                     event.setCanceled(true);
                     return;
                  }

                  float reduced = amount * (1.0F - SymbioteConfig.AEGIS_DAMAGE_REDUCTION.get().floatValue());
                  SymbioteLog.event("AEGIS_ABSORBED player={} before={} after={}", player.getUUID(), amount, reduced);
                  event.setAmount(reduced);
                  amount = reduced;
               }

               if (RupturePounceScene.isActive(player.getUUID())) {
                  float reduced = amount * (1.0F - SymbioteConfig.RUPTURE_SCENE_DAMAGE_REDUCTION.get().floatValue());
                  SymbioteLog.event("RUPTURE_SCENE_ABSORBED player={} before={} after={}", player.getUUID(), amount, reduced);
                  event.setAmount(reduced);
                  amount = reduced;
               }

               if (p.hasCarapace(now)) {
                  float reduced = amount * 0.35000002F;
                  SymbioteLog.event("CARAPACE_ABSORBED player={} before={} after={}", player.getUUID(), amount, reduced);
                  event.setAmount(reduced);
                  amount = reduced;
               }

               if (src.is(DamageTypeTags.IS_FIRE)) {
                  SymbioteTracker.adjustBond(level, player, -SymbioteConfig.BOND_FIRE_DAMAGE.get(), "bond_fire_damage");
                  SymbioteTracker.adjustStress(level, player, 10, "stress_fire");
               }

               if (src.is(DamageTypes.SONIC_BOOM)) {
                  if (p.strain == SymbioteStrain.SCULK) {
                     float reduced = (float)(amount * (1.0 - SymbioteConfig.SCULK_SONIC_RESIST.get()));
                     SymbioteLog.event("SONIC_BOOM_RESISTED player={} strain=sculk before={} after={}", player.getUUID(), amount, reduced);
                     event.setAmount(reduced);
                     amount = reduced;
                  } else {
                     float boosted = (float)(amount * SymbioteConfig.SONIC_BOOM_BONUS_MULT.get());
                     SymbioteLog.event("SONIC_BOOM_AMPLIFIED player={} strain={} before={} after={}", player.getUUID(), p.strain, amount, boosted);
                     event.setAmount(boosted);
                     amount = boosted;
                     SymbioteTracker.adjustStress(level, player, 15, "stress_sonic");
                  }
               }

               boolean absoluteDeath = src.is(DamageTypeTags.BYPASSES_INVULNERABILITY);
               if (!absoluteDeath && LastResortRevival.inAbsorbGrace(player.getUUID(), level.getGameTime())) {
                  event.setCanceled(true);
               } else {
                  if (!absoluteDeath) {
                     EmergencyRegen.maybeTrigger(player, level, p, amount);
                  }

                  if (!absoluteDeath && ArmInstincts.tryTotem(player, level, p, amount)) {
                     event.setCanceled(true);
                  } else if (!absoluteDeath && LastResortRevival.attempt(player, level, p, amount)) {
                     event.setCanceled(true);
                  } else {
                     if (amount >= player.getMaxHealth() * 0.3F
                        && !src.is(DamageTypeTags.IS_FALL)
                        && !BodyControl.recent(player.getUUID(), level.getGameTime(), 40)
                        && level.getGameTime() - CARELESS_LAST.getOrDefault(player.getUUID(), -100000L) >= 12000L) {
                        CARELESS_LAST.put(player.getUUID(), level.getGameTime());
                        VoiceLines.send(player, "symbiote.voice.careless", 2);
                     }

                     if (src.getEntity() instanceof LivingEntity attacker && attacker != player) {
                        SymbioteArmsController.maybeRetaliate(player, p, attacker);
                     }

                     if (p.strain == SymbioteStrain.GUARDIAN
                        && !p.livingArmorActive
                        && amount >= 4.0F
                        && p.stage.isAtLeast(BondStage.INTEGRATED)
                        && Math.random() < 0.35
                        && OverrideGate.check(player, level, p, "guardian_armor_reflex")
                        && LivingArmor.forceOn(player, level, p)) {
                        OverrideGate.stamp(level, p);
                        VoiceLines.send(player, "symbiote.voice.guardian_reflex", 4);
                        SymbioteLog.event("GUARDIAN_REFLEX_ARMOR player={} dmg={}", player.getUUID(), amount);
                     }
                  }
               }
            }
         }
      }
   }

   @SubscribeEvent
   public void onKnockback(LivingKnockBackEvent event) {
      if (event.getEntity() instanceof ServerPlayer player) {
         ServerLevel level = player.serverLevel();
         SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
         if (p != null && p.livingArmorActive) {
            event.setStrength(event.getStrength() * 0.35F);
         }
      }
   }
}
