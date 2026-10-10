package com.scout.symbiote.commands;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.scout.symbiote.ability.DeepSeizure;
import com.scout.symbiote.ability.DominantAssertion;
import com.scout.symbiote.ability.GraftFlow;
import com.scout.symbiote.ability.SymbioteBloom;
import com.scout.symbiote.ability.SymbioteDesires;
import com.scout.symbiote.ability.TendrilSceneController;
import com.scout.symbiote.ability.WalkSeizure;
import com.scout.symbiote.ability.WildHostBrain;
import com.scout.symbiote.bonding.BondingFlow;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.WildHost;
import com.scout.symbiote.failure.ConsumptionDeath;
import com.scout.symbiote.failure.LastResortRevival;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.CreeperSaveOverride;
import com.scout.symbiote.override.FirePanicOverride;
import com.scout.symbiote.override.HungerOverride;
import com.scout.symbiote.override.LowHealthOverride;
import com.scout.symbiote.registry.ModStructures;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import com.scout.symbiote.worldgen.MeteorCrashGenerator;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.EntityArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.TagKey;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.level.levelgen.Heightmap.Types;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.loading.FMLEnvironment;

public class SymbioteCommand {
   @SubscribeEvent
   public void onRegisterCommands(RegisterCommandsEvent event) {
      event.getDispatcher().register(build());
   }

   private static LiteralArgumentBuilder<CommandSourceStack> build() {
      LiteralArgumentBuilder<CommandSourceStack> debug = Commands.literal("debug");
      debug.then(
         ((LiteralArgumentBuilder)Commands.literal("status").executes(ctx -> status(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())))
            .then(Commands.argument("player", EntityArgument.player()).executes(ctx -> status(ctx, EntityArgument.getPlayer(ctx, "player"))))
      );
      debug.then(
         ((LiteralArgumentBuilder)Commands.literal("recover").executes(ctx -> recover(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())))
            .then(Commands.argument("player", EntityArgument.player()).executes(ctx -> recover(ctx, EntityArgument.getPlayer(ctx, "player"))))
      );
      debug.then(
         ((LiteralArgumentBuilder)Commands.literal("dump").executes(ctx -> dump(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())))
            .then(Commands.argument("player", EntityArgument.player()).executes(ctx -> dump(ctx, EntityArgument.getPlayer(ctx, "player"))))
      );
      debug.then(
         ((LiteralArgumentBuilder)Commands.literal("find_meteor").executes(ctx -> findMeteor(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())))
            .then(Commands.argument("player", EntityArgument.player()).executes(ctx -> findMeteor(ctx, EntityArgument.getPlayer(ctx, "player"))))
      );
      debug.then(meter("bond"));
      debug.then(
         ((LiteralArgumentBuilder)Commands.literal("bond_now").executes(ctx -> bondNow(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException(), null)))
            .then(
               ((RequiredArgumentBuilder)Commands.argument("player", EntityArgument.player())
                     .executes(ctx -> bondNow(ctx, EntityArgument.getPlayer(ctx, "player"), null)))
                  .then(
                     Commands.argument("strain", StringArgumentType.word())
                        .executes(ctx -> bondNow(ctx, EntityArgument.getPlayer(ctx, "player"), StringArgumentType.getString(ctx, "strain")))
                  )
            )
      );
      if (!FMLEnvironment.production) {
         registerDevDials(debug);
      }

      return (LiteralArgumentBuilder<CommandSourceStack>)((LiteralArgumentBuilder)Commands.literal("symbiote").requires(src -> src.hasPermission(2))).then(debug);
   }

   private static void registerDevDials(LiteralArgumentBuilder<CommandSourceStack> debug) {
      ((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)debug.then(
                                                                              meter("trust")
                                                                           ))
                                                                           .then(meter("stress")))
                                                                        .then(meter("hunger")))
                                                                     .then(
                                                                        Commands.literal("stage")
                                                                           .then(
                                                                              Commands.argument("player", EntityArgument.player())
                                                                                 .then(
                                                                                    Commands.argument("stage", StringArgumentType.word())
                                                                                       .executes(
                                                                                          ctx -> setStage(
                                                                                             ctx,
                                                                                             EntityArgument.getPlayer(ctx, "player"),
                                                                                             StringArgumentType.getString(ctx, "stage")
                                                                                          )
                                                                                       )
                                                                                 )
                                                                           )
                                                                     ))
                                                                  .then(
                                                                     ((LiteralArgumentBuilder)Commands.literal("rejection")
                                                                           .executes(ctx -> rejection(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())))
                                                                        .then(
                                                                           Commands.argument("player", EntityArgument.player())
                                                                              .executes(ctx -> rejection(ctx, EntityArgument.getPlayer(ctx, "player")))
                                                                        )
                                                                  ))
                                                               .then(
                                                                  ((LiteralArgumentBuilder)Commands.literal("consume")
                                                                        .executes(ctx -> consume(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())))
                                                                     .then(
                                                                        Commands.argument("player", EntityArgument.player())
                                                                           .executes(ctx -> consume(ctx, EntityArgument.getPlayer(ctx, "player")))
                                                                     )
                                                               ))
                                                            .then(
                                                               Commands.literal("desire")
                                                                  .then(
                                                                     ((RequiredArgumentBuilder)((RequiredArgumentBuilder)Commands.argument(
                                                                                 "type", StringArgumentType.word()
                                                                              )
                                                                              .executes(
                                                                                 ctx -> desire(
                                                                                    ctx,
                                                                                    StringArgumentType.getString(ctx, "type"),
                                                                                    ((CommandSourceStack)ctx.getSource()).getPlayerOrException()
                                                                                 )
                                                                              ))
                                                                           .then(
                                                                              Commands.literal("soon")
                                                                                 .executes(
                                                                                    ctx -> desireSoon(
                                                                                       ctx,
                                                                                       StringArgumentType.getString(ctx, "type"),
                                                                                       ((CommandSourceStack)ctx.getSource()).getPlayerOrException()
                                                                                    )
                                                                                 )
                                                                           ))
                                                                        .then(
                                                                           Commands.argument("player", EntityArgument.player())
                                                                              .executes(
                                                                                 ctx -> desire(
                                                                                    ctx,
                                                                                    StringArgumentType.getString(ctx, "type"),
                                                                                    EntityArgument.getPlayer(ctx, "player")
                                                                                 )
                                                                              )
                                                                        )
                                                                  )
                                                            ))
                                                         .then(
                                                            Commands.literal("take")
                                                               .then(
                                                                  Commands.argument("type", StringArgumentType.word())
                                                                     .executes(
                                                                        ctx -> take(
                                                                           ctx,
                                                                           StringArgumentType.getString(ctx, "type"),
                                                                           ((CommandSourceStack)ctx.getSource()).getPlayerOrException()
                                                                        )
                                                                     )
                                                               )
                                                         ))
                                                      .then(
                                                         Commands.literal("control")
                                                            .executes(ctx -> control(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException()))
                                                      ))
                                                   .then(
                                                      Commands.literal("fitcheck")
                                                         .executes(ctx -> fitcheck(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException()))
                                                   ))
                                                .then(
                                                   ((LiteralArgumentBuilder)Commands.literal("seizure")
                                                         .executes(ctx -> seizure(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())))
                                                      .then(
                                                         Commands.argument("player", EntityArgument.player())
                                                            .executes(ctx -> seizure(ctx, EntityArgument.getPlayer(ctx, "player")))
                                                      )
                                                ))
                                             .then(Commands.literal("walkto").executes(ctx -> walkto(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException()))))
                                          .then(
                                             Commands.literal("trigger")
                                                .then(
                                                   ((RequiredArgumentBuilder)Commands.argument("type", StringArgumentType.word())
                                                         .executes(
                                                            ctx -> trigger(
                                                               ctx, StringArgumentType.getString(ctx, "type"), ((CommandSourceStack)ctx.getSource()).getPlayerOrException()
                                                            )
                                                         ))
                                                      .then(
                                                         Commands.argument("player", EntityArgument.player())
                                                            .executes(
                                                               ctx -> trigger(
                                                                  ctx, StringArgumentType.getString(ctx, "type"), EntityArgument.getPlayer(ctx, "player")
                                                               )
                                                            )
                                                      )
                                                )
                                          ))
                                       .then(
                                          Commands.literal("voice")
                                             .then(
                                                ((RequiredArgumentBuilder)Commands.argument("pool_key", StringArgumentType.string())
                                                      .executes(
                                                         ctx -> voice(
                                                            ctx,
                                                            StringArgumentType.getString(ctx, "pool_key"),
                                                            0,
                                                            ((CommandSourceStack)ctx.getSource()).getPlayerOrException()
                                                         )
                                                      ))
                                                   .then(
                                                      ((RequiredArgumentBuilder)Commands.argument("tone", IntegerArgumentType.integer(0, 4))
                                                            .executes(
                                                               ctx -> voice(
                                                                  ctx,
                                                                  StringArgumentType.getString(ctx, "pool_key"),
                                                                  IntegerArgumentType.getInteger(ctx, "tone"),
                                                                  ((CommandSourceStack)ctx.getSource()).getPlayerOrException()
                                                               )
                                                            ))
                                                         .then(
                                                            Commands.argument("player", EntityArgument.player())
                                                               .executes(
                                                                  ctx -> voice(
                                                                     ctx,
                                                                     StringArgumentType.getString(ctx, "pool_key"),
                                                                     IntegerArgumentType.getInteger(ctx, "tone"),
                                                                     EntityArgument.getPlayer(ctx, "player")
                                                                  )
                                                               )
                                                         )
                                                   )
                                             )
                                       ))
                                    .then(
                                       Commands.literal("mood")
                                          .then(
                                             Commands.argument("mood", StringArgumentType.word())
                                                .executes(
                                                   ctx -> mood(ctx, StringArgumentType.getString(ctx, "mood"), ((CommandSourceStack)ctx.getSource()).getPlayerOrException())
                                                )
                                          )
                                    ))
                                 .then(
                                    Commands.literal("beat")
                                       .then(
                                          Commands.argument("type", StringArgumentType.word())
                                             .executes(
                                                ctx -> beat(ctx, StringArgumentType.getString(ctx, "type"), ((CommandSourceStack)ctx.getSource()).getPlayerOrException())
                                             )
                                       )
                                 ))
                              .then(Commands.literal("rapport").executes(ctx -> rapport(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException()))))
                           .then(
                              Commands.literal("morph")
                                 .then(
                                    Commands.argument("form", StringArgumentType.word())
                                       .executes(ctx -> morph(ctx, StringArgumentType.getString(ctx, "form"), ((CommandSourceStack)ctx.getSource()).getPlayerOrException()))
                                 )
                           ))
                        .then(Commands.literal("wildhost").executes(ctx -> wildHost(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException()))))
                     .then(Commands.literal("bloom").executes(ctx -> bloom(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException()))))
                  .then(
                     Commands.literal("graft")
                        .then(
                           ((RequiredArgumentBuilder)Commands.argument("op", StringArgumentType.word())
                                 .executes(ctx -> graft(ctx, StringArgumentType.getString(ctx, "op"), -1, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())))
                              .then(
                                 Commands.argument("value", IntegerArgumentType.integer(0, 100))
                                    .executes(
                                       ctx -> graft(
                                          ctx,
                                          StringArgumentType.getString(ctx, "op"),
                                          IntegerArgumentType.getInteger(ctx, "value"),
                                          ((CommandSourceStack)ctx.getSource()).getPlayerOrException()
                                       )
                                    )
                              )
                        )
                  ))
               .then(
                  ((LiteralArgumentBuilder)Commands.literal("find_lab").executes(ctx -> findLab(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())))
                     .then(Commands.argument("player", EntityArgument.player()).executes(ctx -> findLab(ctx, EntityArgument.getPlayer(ctx, "player"))))
               ))
            .then(
               ((LiteralArgumentBuilder)Commands.literal("place_meteor").executes(ctx -> placeMeteor(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())))
                  .then(Commands.argument("player", EntityArgument.player()).executes(ctx -> placeMeteor(ctx, EntityArgument.getPlayer(ctx, "player"))))
            ))
         .then(Commands.literal("wildhost_scan").executes(ctx -> wildHostScan(ctx, ((CommandSourceStack)ctx.getSource()).getPlayerOrException())));
   }

   private static int wildHostScan(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = player.serverLevel();
      List<Mob> found = level.getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(64.0), mx -> mx.isAlive() && WildHost.isInfected(mx));
      found.sort(Comparator.comparingDouble(mx -> mx.distanceToSqr(player)));
      if (found.isEmpty()) {
         ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("[wildhost] nothing infected within 64 blocks"), false);
         return 0;
      }

      for (Mob m : found) {
         m.addEffect(new MobEffectInstance(MobEffects.GLOWING, 1200, 0, false, false));
         String line = String.format(
            "[wildhost] %s  %.0fm  %s/%s  state=%s  at %d %d %d",
            m.getType().getDescription().getString(),
            Math.sqrt(m.distanceToSqr(player)),
            WildHost.dispositionOf(m),
            WildHost.strainOf(m),
            WildHostBrain.stateOf(m.getId()),
            m.blockPosition().getX(),
            m.blockPosition().getY(),
            m.blockPosition().getZ()
         );
         ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal(line), false);
      }

      ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("[wildhost] " + found.size() + " highlighted for 60s"), false);
      return found.size();
   }

   private static LiteralArgumentBuilder<CommandSourceStack> meter(String name) {
      return (LiteralArgumentBuilder<CommandSourceStack>)Commands.literal(name)
         .then(
            Commands.argument("player", EntityArgument.player())
               .then(
                  Commands.argument("value", IntegerArgumentType.integer(0, 1000))
                     .executes(ctx -> setMeter(ctx, EntityArgument.getPlayer(ctx, "player"), name, IntegerArgumentType.getInteger(ctx, "value")))
               )
         );
   }

   private static int setMeter(CommandContext<CommandSourceStack> ctx, ServerPlayer player, String field, int value) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteTracker t = SymbioteTracker.get(level);
      SymbioteProfile p = t.getOrCreate(player.getUUID());
      switch (field) {
         case "bond":
            p.setBond(value);
            break;
         case "trust":
            p.setTrust(value);
            break;
         case "stress":
            p.setStress(value);
            break;
         case "hunger":
            p.setHunger(value);
      }

      t.setDirty();
      ModNetwork.syncToPlayer(level, player);
      SymbioteLog.event("DEBUG_CMD set field={} value={} player={}", field, value, player.getUUID());
      ((CommandSourceStack)ctx.getSource())
         .sendSuccess(
            () -> Component.literal(String.format("§e[Symbiote] %s.%s = %d (stage %s)", player.getName().getString(), field, value, p.stage.name())), true
         );
      return 1;
   }

   private static int setStage(CommandContext<CommandSourceStack> ctx, ServerPlayer player, String stageStr) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteTracker t = SymbioteTracker.get(level);
      SymbioteProfile p = t.getOrCreate(player.getUUID());

      BondStage stage;
      try {
         stage = BondStage.valueOf(stageStr.toUpperCase());
      } catch (IllegalArgumentException e) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Unknown stage: " + stageStr));
         return 0;
      }

      p.stage = stage;
      p.announcedStage = stage;
      switch (stage) {
         case DOMINANT:
            p.setBond(Math.max(p.bond, (Integer)SymbioteConfig.STAGE_DOMINANT_BOND.get()));
            break;
         case COOPERATIVE:
            p.setBond(Math.max(p.bond, (Integer)SymbioteConfig.STAGE_COOPERATIVE_BOND.get()));
            break;
         case INTEGRATED:
            p.setBond(Math.max(p.bond, (Integer)SymbioteConfig.STAGE_INTEGRATED_BOND.get()));
            break;
         case ATTACHED:
            if (p.bond <= 0) {
               p.setBond(10);
            }
      }

      p.stage = stage;
      p.announcedStage = stage;
      t.setDirty();
      ModNetwork.syncToPlayer(level, player);
      SymbioteLog.event("DEBUG_CMD set_stage stage={} player={}", stage, player.getUUID());
      ((CommandSourceStack)ctx.getSource())
         .sendSuccess(() -> Component.literal(String.format("§e[Symbiote] %s.stage = %s", player.getName().getString(), stage.name())), true);
      return 1;
   }

   private static int fitcheck(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());
      String blocked = DominantAssertion.force(player, level, p);
      if (blocked != null) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("[Symbiote] fit check blocked: " + blocked));
         return 0;
      } else {
         ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("§e[Symbiote] fit check fired (grep DOMINANT_ASSERT)"), true);
         return 1;
      }
   }

   private static int recover(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      if (TendrilSceneController.isInScene(player.getUUID())) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("[Symbiote] mid-scene: let it finish and run recover after respawn"));
         return 0;
      } else {
         SymbioteTracker t = SymbioteTracker.get(level);
         SymbioteProfile p = t.getOrCreate(player.getUUID());
         p.setBond(Math.max((Integer)SymbioteConfig.STAGE_INTEGRATED_BOND.get() + 10, p.bond));
         p.announcedStage = p.stage;
         p.setTrust(Math.max(55, p.trust));
         p.setStress(Math.min(10, p.stress));
         p.setHunger(Math.max(70, p.hunger));
         p.stamina = p.staminaMax();
         p.dormantUntilTick = 0L;
         p.instabilityUntilTick = 0L;
         p.desireType = -1;
         LowHealthOverride.clearEmergency(player.getUUID());
         p.revivalAdrenaline = false;
         LastResortRevival.onLogout(player.getUUID());
         player.fallDistance = 0.0F;
         t.setDirty();
         ModNetwork.syncToPlayer(level, player);
         SymbioteLog.event("DEBUG_CMD recover player={} stage={} strain={}", player.getUUID(), p.stage, p.strain);
         ((CommandSourceStack)ctx.getSource())
            .sendSuccess(
               () -> Component.literal(String.format("§a[Symbiote] recovered: stage=%s strain=%s bond=%d", p.stage.name(), p.strain.name(), p.bond)), true
            );
         return 1;
      }
   }

   private static int status(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p == null) {
         ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("§7[Symbiote] " + player.getName().getString() + ": no profile"), false);
         return 1;
      } else {
         ((CommandSourceStack)ctx.getSource())
            .sendSuccess(
               () -> Component.literal(
                  String.format(
                     "§e[Symbiote] %s: stage=%s strain=%s bond=%d trust=%d stress=%d hunger=%d stamina=%d armorActive=%s dormantUntil=%d instabilityUntil=%d",
                     player.getName().getString(),
                     p.stage.name(),
                     p.strain.name(),
                     p.bond,
                     p.trust,
                     p.stress,
                     p.hunger,
                     p.livingArmorStamina,
                     p.livingArmorActive,
                     p.dormantUntilTick,
                     p.instabilityUntilTick
                  )
               ),
               false
            );
         return 1;
      }
   }

   private static int bondNow(CommandContext<CommandSourceStack> ctx, ServerPlayer player, String strainName) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteStrain strain = null;
      if (strainName != null) {
         try {
            strain = SymbioteStrain.valueOf(strainName.toUpperCase());
         } catch (IllegalArgumentException e) {
            ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Unknown strain: " + strainName));
            return 0;
         }
      }

      BondingFlow.attemptBond(player, level, true, strain);
      SymbioteLog.event("DEBUG_CMD bond_now player={} strain={}", player.getUUID(), strain);
      ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("§e[Symbiote] Force-bonded " + player.getName().getString()), true);
      return 1;
   }

   private static int rejection(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      BondingFlow.forceRejection(player, level);
      ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("§c[Symbiote] Forced rejection on " + player.getName().getString()), true);
      return 1;
   }

   private static int consume(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      ConsumptionDeath.consume(player, level, "debug_force");
      ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("§c[Symbiote] Forced consumption on " + player.getName().getString()), true);
      return 1;
   }

   private static int take(CommandContext<CommandSourceStack> ctx, String type, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());
      int r = SymbioteDesires.forceTaking(player, level, p, type);
      if (r == 0) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Unknown desire: " + type + " (flesh|blood|deep|night|shell)"));
         return 0;
      } else {
         String msg = r == 2
            ? "§e[Symbiote] TAKEN NOW: " + type + " (kills/feeds during it must say 'I did it myself')"
            : "§e[Symbiote] " + type + " armed pre-expired. nothing in reach right now. In survival the patience loop retries every 5s.";
         ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal(msg), true);
         return 1;
      }
   }

   private static int control(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());
      String act = SymbioteDesires.debugRandomTaking(player, level, p);
      if (act == null) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("[Symbiote] nothing it can do here (body busy, or no act available nearby)"));
         return 0;
      } else {
         ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("§e[Symbiote] it takes the body: " + act), true);
         return 1;
      }
   }

   private static int desire(CommandContext<CommandSourceStack> ctx, String type, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());
      boolean ok = SymbioteDesires.forceDesire(player, level, p, type);
      if (!ok) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Unknown desire: " + type + " (flesh|blood|deep|night|shell)"));
         return 0;
      } else {
         ((CommandSourceStack)ctx.getSource())
            .sendSuccess(
               () -> Component.literal(
                  "§e[Symbiote] desire '" + type + "' forced on " + player.getName().getString() + ": fulfill it, or ignore it to see the tantrum"
               ),
               true
            );
         return 1;
      }
   }

   private static int desireSoon(CommandContext<CommandSourceStack> ctx, String type, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());
      boolean ok = SymbioteDesires.forceDesireSoon(player, level, p, type);
      if (!ok) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Unknown desire: " + type + " (flesh|blood|deep|night|shell)"));
         return 0;
      } else {
         ((CommandSourceStack)ctx.getSource())
            .sendSuccess(() -> Component.literal("§e[Symbiote] desire '" + type + "' forced with a 5 second fuse: ignore it to reach the tantrum"), true);
         return 1;
      }
   }

   private static int mood(CommandContext<CommandSourceStack> ctx, String moodName, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());
      long now = level.getGameTime();
      if (moodName.equalsIgnoreCase("off")) {
         p.moodDebugUntil = 0L;
         ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("§e[Symbiote] mood force released: engine resumes"), false);
      } else {
         MoodEngine.Mood m;
         try {
            m = MoodEngine.Mood.valueOf(moodName.toUpperCase());
         } catch (IllegalArgumentException e) {
            ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Unknown mood: " + moodName + " (content|anxious|coiled|grieving|off)"));
            return 0;
         }

         p.moodOrdinal = m.ordinal();
         p.moodDebugUntil = now + 2400L;
         ((CommandSourceStack)ctx.getSource())
            .sendSuccess(() -> Component.literal("§e[Symbiote] mood forced to " + m + " for 2 min on " + player.getName().getString()), false);
      }

      SymbioteTracker.get(level).setDirty();
      ModNetwork.syncToPlayer(level, player);
      return 1;
   }

   private static int beat(CommandContext<CommandSourceStack> ctx, String typeName, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());

      MoodEngine.BeatType t;
      try {
         t = MoodEngine.BeatType.valueOf(typeName.toUpperCase());
      } catch (IllegalArgumentException e) {
         ((CommandSourceStack)ctx.getSource())
            .sendFailure(Component.literal("Unknown beat: " + typeName + " (" + Arrays.toString(MoodEngine.BeatType.values()) + ")"));
         return 0;
      }

      p.addBeat(t, level.getGameTime(), "debug");
      SymbioteTracker.get(level).setDirty();
      ((CommandSourceStack)ctx.getSource())
         .sendSuccess(() -> Component.literal("§e[Symbiote] beat " + t + " (w=" + t.weight + ") recorded: mood re-evaluates within 3s"), false);
      return 1;
   }

   private static int rapport(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p == null) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("No profile."));
         return 0;
      }

      long now = level.getGameTime();
      StringBuilder tail = new StringBuilder();
      int from = Math.max(0, p.beats.size() - 6);

      for (int i = from; i < p.beats.size(); i++) {
         SymbioteProfile.Beat b = p.beats.get(i);
         MoodEngine.BeatType[] types = MoodEngine.BeatType.values();
         String tn = b.type >= 0 && b.type < types.length ? types[b.type].name() : "?" + b.type;
         tail.append(tn).append("(").append((now - b.tick) / 20L).append("s ago) ");
      }

      MoodEngine.Mood m = MoodEngine.evaluate(p, now);
      ((CommandSourceStack)ctx.getSource())
         .sendSuccess(
            () -> Component.literal(
               String.format(
                  "§e[Symbiote] rapport=%d (trust=%d stress=%d) mood=%s%s temperament=%s beats[%d]: %s",
                  p.trust - p.stress,
                  p.trust,
                  p.stress,
                  m,
                  now < p.grievingUntil ? " (GRIEF LOCK " + (p.grievingUntil - now) / 20L + "s)" : "",
                  MoodEngine.Temperament.values()[Math.floorMod(p.temperamentOrdinal, MoodEngine.Temperament.values().length)],
                  p.beats.size(),
                  tail.length() == 0 ? "(none)" : tail.toString().trim()
               )
            ),
            false
         );
      return 1;
   }

   private static int morph(CommandContext<CommandSourceStack> ctx, String form, ServerPlayer player) {
      String f = form.toLowerCase(Locale.ROOT);
      if (f.equals("off")) {
         ModNetwork.sendOverrideFx(player, "morph:blade", 0);
         ModNetwork.sendOverrideFx(player, "morph:shield", 0);
         ModNetwork.sendOverrideFx(player, "morph:claw", 0);
         ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("§e[Symbiote] morph cleared"), false);
         return 1;
      } else if (!f.equals("blade") && !f.equals("shield") && !f.equals("claw")) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Unknown form: " + form + " (blade|shield|claw|off)"));
         return 0;
      } else {
         ModNetwork.sendOverrideFx(player, "morph:" + f, 400);
         ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("§e[Symbiote] morph → " + f + " (20s. EMPTY main hand to see it)"), false);
         return 1;
      }
   }

   private static int graft(CommandContext<CommandSourceStack> ctx, String op, int value, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());
      if (!p.stage.isBonded()) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Not bonded. Bond first (bond_now)."));
         return 0;
      }

      String o = op.toLowerCase(Locale.ROOT);
      switch (o) {
         case "attach":
            SymbioteStrain s = value >= 0
               ? SymbioteStrain.fromOrdinalSafe(value % SymbioteStrain.values().length)
               : SymbioteStrain.fromOrdinalSafe((p.strain.ordinal() + 1) % SymbioteStrain.values().length);
            GraftFlow.attach(player, level, s);
            break;
         case "detach":
            GraftFlow.detach(player, level, "debug");
            break;
         case "purge":
            if (p.graft == null) {
               ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("No graft to purge."));
               return 0;
            }

            TendrilSceneController.startGraftPurge(player, level, p.strain, p.graft.strain);
            break;
         case "tension":
         case "hunger":
            if (p.graft == null) {
               ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("No graft."));
               return 0;
            }

            if (value < 0) {
               ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Needs a value 0-100."));
               return 0;
            }

            if (o.equals("tension")) {
               p.graft.tension = value;
            } else {
               p.graft.hunger = value;
            }
            break;
         default:
            ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Unknown op: " + op + " (attach|detach|purge|tension|hunger)"));
            return 0;
      }

      SymbioteTracker.get(level).setDirty();
      ModNetwork.syncToPlayer(level, player);
      String state = p.graft == null ? "none" : p.graft.strain + " hunger=" + p.graft.hunger + " tension=" + p.graft.tension;
      ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal("§e[Symbiote] graft → " + state), false);
      return 1;
   }

   private static int bloom(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());
      if (!p.stage.isBonded()) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Not bonded. Bond first (bond_now)."));
         return 0;
      } else {
         SymbioteBloom.force(player, level, p);
         int lit = SymbioteBloom.pulseSenseCounted(player, level, p);
         ((CommandSourceStack)ctx.getSource())
            .sendSuccess(
               () -> Component.literal(
                  "§e[Symbiote] bloom open. THIRD PERSON (F5) for the crown. 360 sense lit "
                     + lit
                     + " living things"
                     + (lit == 0 ? " §c(nothing alive within 24 blocks: spawn some mobs or go underground, the sense has nothing to show)" : "")
               ),
               false
            );
         return 1;
      }
   }

   private static int wildHost(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      Mob target = null;
      double bestSq = Double.MAX_VALUE;

      for (Mob m : level.getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(24.0), e -> e.isAlive() && !WildHost.isInfected(e))) {
         double d = m.distanceToSqr(player);
         if (d < bestSq) {
            bestSq = d;
            target = m;
         }
      }

      if (target == null) {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("No uninfected mob within 24 blocks. Spawn something first."));
         return 0;
      } else {
         SymbioteStrain[] strains = SymbioteStrain.values();
         SymbioteStrain strain = strains[level.random.nextInt(strains.length)];
         WildHost.infect(target, strain, level.getGameTime());
         String what = target.getType().toString();
         ((CommandSourceStack)ctx.getSource())
            .sendSuccess(
               () -> Component.literal("§e[Symbiote] infected " + what + " (" + strain + "). Back off 30+ blocks and walk back to hear the sense."), false
            );
         return 1;
      }
   }

   private static int walkto(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());
      if (player.pick(48.0, 0.0F, false) instanceof BlockHitResult bhr) {
         boolean ok = WalkSeizure.start(player, level, p, bhr.getBlockPos().above());
         ((CommandSourceStack)ctx.getSource())
            .sendSuccess(
               () -> Component.literal(
                  "§e[Symbiote] walk seizure → " + (ok ? "WALKING to " + bhr.getBlockPos().above() + ": try to resist" : "no path from here")
               ),
               true
            );
         return 1;
      } else {
         ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Look at a block (within 48) to walk to."));
         return 0;
      }
   }

   private static int seizure(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());
      boolean ok = DeepSeizure.start(player, level, p);
      ((CommandSourceStack)ctx.getSource())
         .sendSuccess(
            () -> Component.literal("§e[Symbiote] deep seizure → " + (ok ? "STARTED: fight the camera" : "refused (fluid or unbreakable directly below)")),
            true
         );
      return 1;
   }

   private static int trigger(CommandContext<CommandSourceStack> ctx, String type, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).getOrCreate(player.getUUID());

      boolean fired = switch (type) {
         case "creeper_save" -> CreeperSaveOverride.forceTrigger(player, level, p);
         case "fire_panic" -> FirePanicOverride.forceTrigger(player, level, p);
         case "low_health" -> LowHealthOverride.forceTrigger(player, level, p);
         case "hunger_override" -> HungerOverride.forceTrigger(player, level, p);
         default -> {
            ((CommandSourceStack)ctx.getSource()).sendFailure(Component.literal("Unknown override type: " + type));
            yield false;
         }
      };
      ((CommandSourceStack)ctx.getSource())
         .sendSuccess(
            () -> Component.literal(String.format("§e[Symbiote] trigger %s on %s → %s", type, player.getName().getString(), fired ? "FIRED" : "skipped")),
            true
         );
      return 1;
   }

   private static int voice(CommandContext<CommandSourceStack> ctx, String pool, int tone, ServerPlayer player) {
      VoiceLines.send(player, pool, tone);
      ((CommandSourceStack)ctx.getSource())
         .sendSuccess(() -> Component.literal(String.format("§e[Symbiote] voice %s tone=%d → %s", pool, tone, player.getName().getString())), false);
      return 1;
   }

   private static int dump(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      StringBuilder sb = new StringBuilder("§e[Symbiote dump]\n");
      if (p == null) {
         sb.append("  no profile\n");
      } else {
         sb.append(String.format("  player: %s\n", player.getName().getString()));
         sb.append(String.format("  stage: %s   bond: %d   trust: %d   stress: %d   hunger: %d\n", p.stage.name(), p.bond, p.trust, p.stress, p.hunger));
         sb.append(String.format("  livingArmor: active=%s stamina=%d\n", p.livingArmorActive, p.livingArmorStamina));
         sb.append(
            String.format(
               "  dormantUntilTick: %d   instabilityUntilTick: %d   lastOverrideTick: %d\n", p.dormantUntilTick, p.instabilityUntilTick, p.lastOverrideTick
            )
         );
         sb.append(String.format("  worldTick: %d\n", level.getGameTime()));
      }

      ((CommandSourceStack)ctx.getSource()).sendSuccess(() -> Component.literal(sb.toString()), false);
      return 1;
   }

   private static int placeMeteor(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      Vec3 look = player.getLookAngle();
      int dx = (int)(look.x * 20.0);
      int dz = (int)(look.z * 20.0);
      int x = player.blockPosition().getX() + dx;
      int z = player.blockPosition().getZ() + dz;
      int y = level.getHeight(Types.MOTION_BLOCKING_NO_LEAVES, x, z);
      BlockPos pos = new BlockPos(x, y, z);
      MeteorCrashGenerator.place(level, pos);
      ((CommandSourceStack)ctx.getSource())
         .sendSuccess(
            () -> Component.literal(
               String.format(
                  "§e[Symbiote] Placed meteor at (%d, %d, %d): ~20 blocks in your look direction.", pos.getX(), pos.getY(), pos.getZ()
               )
            ),
            true
         );
      return 1;
   }

   private static int findMeteor(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      return findStructure(ctx, player, ModStructures.METEOR_CRASH_TAG, "meteor crash site", "symbiote:meteor_crash");
   }

   private static int findLab(CommandContext<CommandSourceStack> ctx, ServerPlayer player) {
      return findStructure(ctx, player, ModStructures.ANCIENT_LAB_TAG, "ancient lab", "symbiote:ancient_lab");
   }

   private static int findStructure(CommandContext<CommandSourceStack> ctx, ServerPlayer player, TagKey<Structure> tag, String label, String id) {
      ServerLevel level = ((CommandSourceStack)ctx.getSource()).getLevel();
      BlockPos found = level.findNearestMapStructure(tag, player.blockPosition(), 100, false);
      if (found == null) {
         ((CommandSourceStack)ctx.getSource())
            .sendSuccess(
               () -> Component.literal(String.format("§7[Symbiote] No %s within 100 chunks. Vanilla §f/locate structure %s§7 works too.", label, id)), false
            );
         return 1;
      } else {
         double dx = found.getX() - player.getX();
         double dz = found.getZ() - player.getZ();
         double dist = Math.sqrt(dx * dx + dz * dz);
         ((CommandSourceStack)ctx.getSource())
            .sendSuccess(
               () -> Component.literal(
                  String.format("§e[Symbiote] Nearest %s: §f(%d, ~, %d)§e, §f%.0f§e blocks away.", label, found.getX(), found.getZ(), dist)
               ),
               false
            );
         return 1;
      }
   }
}
