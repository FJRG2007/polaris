package com.scout.symbiote.client;

import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.scout.symbiote.network.ModNetwork;
import net.minecraft.client.Minecraft;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.RegisterClientCommandsEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.loading.FMLEnvironment;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class MantleTuneCommand {
   @SubscribeEvent
   public static void onRegisterClientCommands(RegisterClientCommandsEvent event) {
      if (!FMLEnvironment.production) {
         event.getDispatcher().register(build());
      }
   }

   private static LiteralArgumentBuilder<CommandSourceStack> build() {
      return (LiteralArgumentBuilder<CommandSourceStack>)((LiteralArgumentBuilder)((LiteralArgumentBuilder)Commands.literal("symmantle")
               .then(Commands.literal("gui").executes(c -> {
                  ModNetwork.sendGraft("mantle", "");
                  Minecraft mc = Minecraft.getInstance();
                  mc.schedule(() -> mc.setScreen(new MantleTuneScreen()));
                  return 1;
               })))
            .then(Commands.literal("up").executes(c -> {
               ModNetwork.sendGraft("mantle", "");
               return 1;
            })))
         .then(Commands.literal("off").executes(c -> {
            ModNetwork.sendGraft("mantle_off", "");
            return 1;
         }));
   }

   private MantleTuneCommand() {
   }
}
