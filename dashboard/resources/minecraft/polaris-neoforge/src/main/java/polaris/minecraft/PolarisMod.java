package polaris.minecraft;

import com.mojang.logging.LogUtils;
import net.minecraft.nbt.CompoundTag;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.attachment.AttachmentType;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.registries.DeferredRegister;
import net.neoforged.neoforge.registries.NeoForgeRegistries;
import org.slf4j.Logger;

/**
 * Polaris on a NeoForge server.
 *
 * Loaded on dedicated servers only: everything it does happens on the server, and
 * a player joins with an unmodified client. The login stays idle unless the
 * server's environment switches it on, which is what makes a jar left in the mods
 * folder after the switch was turned off harmless. The anti-xray runs unless the
 * environment switches it off (POLARIS_ANTIXRAY=off). Chat moderation runs
 * wherever Polaris wrote its address, id and token, for either of them. The
 * event commands ({@link EventCommands}) are always there: idle until the
 * dashboard runs one.
 */
@Mod(value = PolarisMod.ID, dist = Dist.DEDICATED_SERVER)
public final class PolarisMod {
    public static final String ID = "polaris";
    static final Logger LOG = LogUtils.getLogger();

    private static final DeferredRegister<AttachmentType<?>> ATTACHMENTS =
            DeferredRegister.create(NeoForgeRegistries.ATTACHMENT_TYPES, ID);

    public PolarisMod(IEventBus modBus, ModContainer container) {
        PolarisConfig config = PolarisConfig.fromEnvironment(System.getenv());
        String version = container.getModInfo().getVersion().toString();
        // Which event stashes a player is owed: saved in their player file and
        // kept through death, so a crash can be told apart from a give-back.
        EventStash.marks = ATTACHMENTS.register("event_stash", () -> AttachmentType.builder(() -> new CompoundTag())
                .serialize(CompoundTag.CODEC)
                .copyOnDeath()
                .build());
        ATTACHMENTS.register(modBus);
        NeoForge.EVENT_BUS.register(new EventCommands(version));
        if (AntiXray.wanted(System.getenv())) {
            AntiXrayLink.start(PolarisConfig.linkFromEnvironment(System.getenv()));
            NeoForge.EVENT_BUS.register(new AntiXray());
        }
        // Whenever Polaris has said where it is - for the login or for the
        // anti-cheat - the chat follows the rules on the server's Moderation tab.
        ChatModeration chat = ChatModeration.start(version);
        if (chat != null) NeoForge.EVENT_BUS.register(chat);
        switch (config.state()) {
            case OFF -> {
                LOG.info("Polaris login is installed but switched off for this server.");
                return;
            }
            case BROKEN -> LOG.error(
                    "Polaris login is switched on but cannot run: {}. Every player will be refused until this is fixed.",
                    config.problem());
            case ON -> LOG.info("Polaris login is on. Players are checked against {}.", config.baseUrl());
        }
        NeoForge.EVENT_BUS.register(new LoginGate(config, new PolarisClient(config, version), version));
    }
}
