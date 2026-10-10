/*
 * This file is part of packetevents - https://github.com/retrooper/packetevents
 * Copyright (C) 2024 retrooper and contributors
 *
 * Carried over from packetevents' Fabric platform (v2.14.0) to NeoForge by Polaris.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
package polaris.anticheat.platform.neoforge.packetevents;

import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.PacketEventsAPI;
import com.github.retrooper.packetevents.injector.ChannelInjector;
import com.github.retrooper.packetevents.manager.player.PlayerManager;
import com.github.retrooper.packetevents.manager.protocol.ProtocolManager;
import com.github.retrooper.packetevents.manager.server.ServerManager;
import com.github.retrooper.packetevents.netty.NettyManager;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.settings.PacketEventsSettings;
import com.github.retrooper.packetevents.util.PEVersions;
import io.github.retrooper.packetevents.impl.netty.NettyManagerImpl;
import net.minecraft.SharedConstants;

import java.util.Locale;

/**
 * PacketEvents on a dedicated NeoForge server: the Fabric platform's API with the
 * loader taken out. Packets are read and written by the two handlers the connection
 * mixin puts on every player's pipeline; nothing here touches the server's own
 * networking.
 */
public final class NeoForgePacketEventsAPI extends PacketEventsAPI<String> {

    private final String modId;
    private final PacketEventsSettings settings;
    private final ProtocolManager protocolManager = new NeoForgeProtocolManager();
    private final ServerManager serverManager;
    private final PlayerManager playerManager = new NeoForgePlayerManager();
    private final ChannelInjector injector = new NeoForgeChannelInjector();
    private final NettyManager nettyManager = new NettyManagerImpl();
    private boolean loaded;
    private boolean initialized;
    private boolean terminated;

    public NeoForgePacketEventsAPI(String modId, PacketEventsSettings settings) {
        this.modId = modId;
        this.settings = settings;
        SharedConstants.tryDetectVersion();
        this.serverManager = new NeoForgeServerManager(SharedConstants.getCurrentVersion().getName());
    }

    @Override
    public void load() {
        if (this.loaded) {
            return;
        }
        String id = ("server_" + this.modId).toLowerCase(Locale.ROOT);
        PacketEvents.IDENTIFIER = "pe-" + id;
        PacketEvents.ENCODER_NAME = "pe-encoder-" + id;
        PacketEvents.DECODER_NAME = "pe-decoder-" + id;
        PacketEvents.CONNECTION_HANDLER_NAME = "pe-connection-handler-" + id;
        PacketEvents.SERVER_CHANNEL_HANDLER_NAME = "pe-connection-initializer-" + id;
        super.load();
        this.loaded = true;
        this.getLogManager().info("Loaded packetevents v" + PEVersions.RAW);
    }

    @Override
    public boolean isLoaded() {
        return this.loaded;
    }

    @Override
    public void init() {
        this.load();
        if (this.initialized) {
            return;
        }
        PacketType.Play.Client.load();
        PacketType.Play.Server.load();
        this.initialized = true;
    }

    @Override
    public boolean isInitialized() {
        return this.initialized;
    }

    @Override
    public void terminate() {
        if (!this.initialized) {
            return;
        }
        super.terminate();
        this.initialized = false;
        this.terminated = true;
    }

    @Override
    public boolean isTerminated() {
        return this.terminated;
    }

    @Override
    public String getPlugin() {
        return this.modId;
    }

    @Override
    public ProtocolManager getProtocolManager() {
        return this.protocolManager;
    }

    @Override
    public ServerManager getServerManager() {
        return this.serverManager;
    }

    @Override
    public PlayerManager getPlayerManager() {
        return this.playerManager;
    }

    @Override
    public ChannelInjector getInjector() {
        return this.injector;
    }

    @Override
    public PacketEventsSettings getSettings() {
        return this.settings;
    }

    @Override
    public NettyManager getNettyManager() {
        return this.nettyManager;
    }
}
