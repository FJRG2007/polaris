package com.scout.symbiote;

import com.mojang.logging.LogUtils;
import com.scout.symbiote.commands.SymbioteCommand;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.event.LivingDeathListener;
import com.scout.symbiote.event.LivingHurtListener;
import com.scout.symbiote.event.PlayerDeathListener;
import com.scout.symbiote.event.PlayerOutgoingDamageListener;
import com.scout.symbiote.event.SeizedInteractionListener;
import com.scout.symbiote.event.SleepListener;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.network.SymbioteSyncOnJoin;
import com.scout.symbiote.registry.ModBlockEntities;
import com.scout.symbiote.registry.ModBlocks;
import com.scout.symbiote.registry.ModCreativeTabs;
import com.scout.symbiote.registry.ModEntities;
import com.scout.symbiote.registry.ModItems;
import com.scout.symbiote.registry.ModMenus;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.registry.ModStructures;
import com.scout.symbiote.tick.SymbioteTickHandler;
import com.scout.symbiote.util.ForeignHooks;
import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.server.level.ServerLevel;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.ModList;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.config.ModConfig.Type;
import net.neoforged.fml.event.lifecycle.FMLCommonSetupEvent;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.neoforge.common.NeoForge;
import org.slf4j.Logger;

@Mod("symbiote")
public class SymbioteMod {
   public static final String MODID = "symbiote";
   public static final Logger LOGGER = LogUtils.getLogger();

   public SymbioteMod(IEventBus modBus, ModContainer container) {
      ForeignHooks.enforce();
      IEventBus forgeBus = NeoForge.EVENT_BUS;
      container.registerConfig(Type.COMMON, SymbioteConfig.SPEC, "symbiote-common.toml");
      container.registerConfig(Type.CLIENT, SymbioteConfig.CLIENT_SPEC, "symbiote-client.toml");
      modBus.addListener(ModEntities::registerAttributes);
      modBus.addListener(ModNetwork::register);
      ModItems.REGISTER.register(modBus);
      ModBlocks.REGISTER.register(modBus);
      ModBlockEntities.REGISTER.register(modBus);
      ModEntities.REGISTER.register(modBus);
      ModCreativeTabs.REGISTER.register(modBus);
      ModStructures.STRUCTURE_TYPES.register(modBus);
      ModStructures.STRUCTURE_PIECES.register(modBus);
      ModMenus.REGISTER.register(modBus);
      ModSounds.REGISTER.register(modBus);
      modBus.addListener(this::commonSetup);
      forgeBus.register(new SymbioteSyncOnJoin());
      forgeBus.register(new SymbioteTickHandler());
      forgeBus.register(new LivingHurtListener());
      forgeBus.register(new LivingDeathListener());
      forgeBus.register(new SleepListener());
      forgeBus.register(new PlayerDeathListener());
      if (ModList.get().isLoaded("curios")) {
         forgeBus.register(new com.scout.symbiote.compat.CuriosRebondCompat());
      }

      forgeBus.register(new PlayerOutgoingDamageListener());
      forgeBus.register(new SeizedInteractionListener());
      forgeBus.register(new SymbioteCommand());
      if (FMLEnvironment.dist == Dist.CLIENT) {
         SymbioteClientBootstrap.init(container, forgeBus);
      }

      LOGGER.info("Symbiote loaded: loss of control is the feature.");
   }

   private void commonSetup(FMLCommonSetupEvent event) {
      SymbioteLog.verbose = SymbioteConfig.VERBOSE_LOGGING.get();
   }

   public static long worldTimeOrZero(ServerLevel level) {
      return level != null ? level.getGameTime() : 0L;
   }
}
