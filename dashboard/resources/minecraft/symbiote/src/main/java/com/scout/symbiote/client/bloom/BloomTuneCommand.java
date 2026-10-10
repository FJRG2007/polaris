package com.scout.symbiote.client.bloom;

import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import net.minecraft.client.Minecraft;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.RegisterClientCommandsEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.loading.FMLEnvironment;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class BloomTuneCommand {
   @SubscribeEvent
   public static void onRegisterClientCommands(RegisterClientCommandsEvent event) {
      if (!FMLEnvironment.production) {
         event.getDispatcher().register(build());
      }
   }

   private static LiteralArgumentBuilder<CommandSourceStack> build() {
      return (LiteralArgumentBuilder<CommandSourceStack>)((LiteralArgumentBuilder)((LiteralArgumentBuilder)Commands.literal("symbloom")
               .then(Commands.literal("gui").executes(c -> openGui())))
            .then(Commands.literal("show").executes(c -> preview(true, (CommandSourceStack)c.getSource()))))
         .then(Commands.literal("hide").executes(c -> preview(false, (CommandSourceStack)c.getSource())));
   }

   private static int openGui() {
      BloomRenderLayer.preview = true;
      Minecraft mc = Minecraft.getInstance();
      mc.schedule(() -> mc.setScreen(new BloomTuneScreen()));
      return 1;
   }

   private static int preview(boolean on, CommandSourceStack src) {
      BloomRenderLayer.preview = on;
      src.sendSuccess(() -> Component.literal("§e[bloom] preview " + (on ? "ON (F5 to see it)" : "off")), false);
      return 1;
   }

   private BloomTuneCommand() {
   }
}
