package polaris.anticheat.platform.api.manager.cloud;

import polaris.anticheat.platform.api.command.PlayerSelector;
import polaris.anticheat.platform.api.sender.Sender;
import org.incendo.cloud.parser.ParserDescriptor;
import org.incendo.cloud.suggestion.SuggestionProvider;

public interface CloudPlatformCommandArguments {
    ParserDescriptor<Sender, PlayerSelector> singlePlayerSelectorParser();

    SuggestionProvider<Sender> onlinePlayerSuggestions();
}
