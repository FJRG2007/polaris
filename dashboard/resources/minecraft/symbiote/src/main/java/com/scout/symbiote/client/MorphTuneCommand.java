package com.scout.symbiote.client;

import com.mojang.brigadier.arguments.FloatArgumentType;
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
public final class MorphTuneCommand {
   @SubscribeEvent
   public static void onRegisterClientCommands(RegisterClientCommandsEvent event) {
      if (!FMLEnvironment.production) {
         event.getDispatcher().register(build());
      }
   }

   private static LiteralArgumentBuilder<CommandSourceStack> build() {
      return (LiteralArgumentBuilder<CommandSourceStack>)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)((LiteralArgumentBuilder)Commands.literal(
                                    "symmorph"
                                 )
                                 .then(
                                    Commands.literal("x")
                                       .then(
                                          Commands.argument("v", FloatArgumentType.floatArg())
                                             .executes(c -> set("x", FloatArgumentType.getFloat(c, "v"), (CommandSourceStack)c.getSource()))
                                       )
                                 ))
                              .then(
                                 Commands.literal("y")
                                    .then(
                                       Commands.argument("v", FloatArgumentType.floatArg())
                                          .executes(c -> set("y", FloatArgumentType.getFloat(c, "v"), (CommandSourceStack)c.getSource()))
                                    )
                              ))
                           .then(
                              Commands.literal("z")
                                 .then(
                                    Commands.argument("v", FloatArgumentType.floatArg())
                                       .executes(c -> set("z", FloatArgumentType.getFloat(c, "v"), (CommandSourceStack)c.getSource()))
                                 )
                           ))
                        .then(
                           Commands.literal("scale")
                              .then(
                                 Commands.argument("v", FloatArgumentType.floatArg(0.05F, 12.0F))
                                    .executes(c -> set("scale", FloatArgumentType.getFloat(c, "v"), (CommandSourceStack)c.getSource()))
                              )
                        ))
                     .then(
                        Commands.literal("pitch")
                           .then(
                              Commands.argument("v", FloatArgumentType.floatArg(-180.0F, 180.0F))
                                 .executes(c -> set("pitch", FloatArgumentType.getFloat(c, "v"), (CommandSourceStack)c.getSource()))
                           )
                     ))
                  .then(
                     Commands.literal("yaw")
                        .then(
                           Commands.argument("v", FloatArgumentType.floatArg(-180.0F, 180.0F))
                              .executes(c -> set("yaw", FloatArgumentType.getFloat(c, "v"), (CommandSourceStack)c.getSource()))
                        )
                  ))
               .then(
                  Commands.literal("roll")
                     .then(
                        Commands.argument("v", FloatArgumentType.floatArg(-180.0F, 180.0F))
                           .executes(c -> set("roll", FloatArgumentType.getFloat(c, "v"), (CommandSourceStack)c.getSource()))
                     )
               ))
            .then(Commands.literal("gui").executes(c -> openGui((CommandSourceStack)c.getSource()))))
         .then(Commands.literal("show").executes(c -> show((CommandSourceStack)c.getSource())));
   }

   private static int openGui(CommandSourceStack src) {
      Minecraft mc = Minecraft.getInstance();
      if (HandMorphRenderer.previewForm == null) {
         HandMorphRenderer.previewForm = HandMorphRenderer.Form.BLADE;
      }

      mc.schedule(() -> mc.setScreen(new MorphTuneScreen()));
      return 1;
   }

   private static int set(String which, float v, CommandSourceStack src) {
      switch (which) {
         case "x":
            HandMorphRenderer.tipX = v;
            break;
         case "y":
            HandMorphRenderer.tipY = v;
            break;
         case "z":
            HandMorphRenderer.tipZ = v;
            break;
         case "scale":
            HandMorphRenderer.scale = v;
            break;
         case "pitch":
            HandMorphRenderer.pitch = v;
            break;
         case "yaw":
            HandMorphRenderer.yaw = v;
            break;
         case "roll":
            HandMorphRenderer.roll = v;
      }

      return show(src);
   }

   private static int show(CommandSourceStack src) {
      src.sendSuccess(
         () -> Component.literal(
            String.format(
               "§e[morph] x=%.3f y=%.3f z=%.3f scale=%.2f pitch=%.0f yaw=%.0f roll=%.0f  §7(+x right, +y up, -z forward. pitch=aim up/down, yaw=left/right)",
               HandMorphRenderer.tipX,
               HandMorphRenderer.tipY,
               HandMorphRenderer.tipZ,
               HandMorphRenderer.scale,
               HandMorphRenderer.pitch,
               HandMorphRenderer.yaw,
               HandMorphRenderer.roll
            )
         ),
         false
      );
      return 1;
   }

   private MorphTuneCommand() {
   }
}
