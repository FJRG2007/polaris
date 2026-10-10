package com.scout.symbiote.client.armor;

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
public final class FormToggleCommand {
   @SubscribeEvent
   public static void onRegisterClientCommands(RegisterClientCommandsEvent event) {
      if (!FMLEnvironment.production) {
         event.getDispatcher().register(build());
      }
   }

   private static LiteralArgumentBuilder<CommandSourceStack> build() {
      return (LiteralArgumentBuilder<CommandSourceStack>)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)Commands.literal(
                        "symform"
                     )
                     .executes(c -> report((CommandSourceStack)c.getSource())))
                  .then(Commands.literal("toggle").executes(c -> {
                     LivingArmorModel.horrorForm = !LivingArmorModel.horrorForm;
                     return report((CommandSourceStack)c.getSource());
                  })))
               .then(Commands.literal("horror").executes(c -> {
                  LivingArmorModel.horrorForm = true;
                  return report((CommandSourceStack)c.getSource());
               })))
            .then(Commands.literal("classic").executes(c -> {
               LivingArmorModel.horrorForm = false;
               return report((CommandSourceStack)c.getSource());
            })))
         .then(Commands.literal("gui").executes(c -> {
            LivingArmorModel.horrorForm = true;
            Minecraft mc = Minecraft.getInstance();
            mc.schedule(() -> mc.setScreen(new FormTuneScreen()));
            return 1;
         }));
   }

   private static int report(CommandSourceStack src) {
      src.sendSuccess(
         () -> Component.literal(
            "§e[symbiote] armor form: " + (LivingArmorModel.horrorForm ? "§cHORROR" : "§7CLASSIC") + "§e (G to toggle the armor, F5 for third person)"
         ),
         false
      );
      return 1;
   }

   private FormToggleCommand() {
   }
}
