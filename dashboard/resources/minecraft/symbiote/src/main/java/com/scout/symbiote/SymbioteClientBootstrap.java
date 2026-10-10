package com.scout.symbiote;

import com.scout.symbiote.client.SymbioteClientResetHandler;
import com.scout.symbiote.client.SymbioteConfigScreen;
import com.scout.symbiote.client.SymbioteKeybindHandler;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.neoforge.client.gui.IConfigScreenFactory;

/** Client-only wiring, kept out of {@link SymbioteMod} so a dedicated server never loads client classes. */
final class SymbioteClientBootstrap {
   static void init(ModContainer container, IEventBus gameBus) {
      container.registerExtensionPoint(IConfigScreenFactory.class, (mc, parent) -> new SymbioteConfigScreen(parent));
      gameBus.register(new SymbioteClientResetHandler());
      gameBus.register(new SymbioteKeybindHandler());
   }

   private SymbioteClientBootstrap() {
   }
}
