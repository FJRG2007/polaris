/**
 * Games this app recognizes by the program that runs them.
 *
 * Matched against the bare name of each running program, lowercased, the way
 * the dashboard keys a game (`gameKeyOf`): the folder a game is installed in
 * differs from one computer to the next, the program's own name does not.
 *
 * Deliberately short and deliberately exact. A name that many programs share -
 * `java`, `javaw.exe`, `python` - is never on it, because "Playing Minecraft"
 * beside somebody running a build tool is a false thing said about them in front
 * of everybody they know. Anything missing is one press away: the settings page
 * adds any running program as a game of its own.
 *
 * A game running through a compatibility layer on Linux keeps its Windows
 * program name, which is why most entries have only the `.exe` form and still
 * match there.
 */

export interface KnownGame {
    /** What the card says: "Playing <name>". */
    readonly name: string;
    /** The programs that mean it is running, lowercased, without a folder. */
    readonly programs: readonly string[];
}

export const KNOWN_GAMES: readonly KnownGame[] = [
    { name: "Among Us", programs: ["among us.exe"] },
    { name: "Apex Legends", programs: ["r5apex.exe"] },
    { name: "ARK: Survival Evolved", programs: ["shootergame.exe"] },
    { name: "Baldur's Gate 3", programs: ["bg3.exe", "bg3_dx11.exe"] },
    { name: "Celeste", programs: ["celeste.exe"] },
    { name: "Counter-Strike 2", programs: ["cs2.exe", "cs2"] },
    { name: "Cyberpunk 2077", programs: ["cyberpunk2077.exe"] },
    { name: "Dead by Daylight", programs: ["deadbydaylight-win64-shipping.exe"] },
    { name: "Dota 2", programs: ["dota2.exe", "dota2"] },
    { name: "Elden Ring", programs: ["eldenring.exe"] },
    { name: "Factorio", programs: ["factorio.exe", "factorio"] },
    { name: "FiveM", programs: ["fivem.exe"] },
    { name: "Fortnite", programs: ["fortniteclient-win64-shipping.exe"] },
    { name: "Genshin Impact", programs: ["genshinimpact.exe"] },
    { name: "Grand Theft Auto V", programs: ["gta5.exe"] },
    { name: "Helldivers 2", programs: ["helldivers2.exe"] },
    { name: "Hollow Knight", programs: ["hollow_knight.exe"] },
    { name: "Lethal Company", programs: ["lethal company.exe"] },
    { name: "League of Legends", programs: ["league of legends.exe"] },
    { name: "Minecraft", programs: ["minecraft.windows.exe"] },
    { name: "osu!", programs: ["osu!.exe"] },
    { name: "Overwatch 2", programs: ["overwatch.exe"] },
    { name: "Palworld", programs: ["palworld-win64-shipping.exe"] },
    { name: "PUBG: Battlegrounds", programs: ["tslgame.exe"] },
    { name: "Rainbow Six Siege", programs: ["rainbowsix.exe"] },
    { name: "Roblox", programs: ["robloxplayerbeta.exe"] },
    { name: "Rocket League", programs: ["rocketleague.exe"] },
    { name: "Rust", programs: ["rustclient.exe"] },
    { name: "Sea of Thieves", programs: ["sotgame.exe"] },
    { name: "Terraria", programs: ["terraria.exe"] },
    { name: "The Sims 4", programs: ["ts4_x64.exe"] },
    { name: "Valheim", programs: ["valheim.exe"] },
    { name: "VALORANT", programs: ["valorant-win64-shipping.exe"] },
    { name: "World of Warcraft", programs: ["wow.exe"] }
];
