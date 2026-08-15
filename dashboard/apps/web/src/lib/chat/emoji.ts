"use client";

/**
 * The emoji the picker offers.
 *
 * A written list rather than a dependency. The packages that do this ship the
 * full Unicode set with names, keywords and skin-tone permutations - several
 * hundred kilobytes into the browser bundle - and what a picker beside a chat
 * box needs is the ones people actually send. This is that, grouped the way
 * every picker groups them, with enough keywords to find one by typing.
 *
 * Nothing here is per-user and nothing is stored: an emoji is characters in the
 * message body, which is why a reaction and a message can carry the same one
 * without either knowing about this file.
 */

export interface EmojiGroup {
    readonly name: string;
    /** Drawn on the tab strip. One of its own members, so the tabs need no
     *  icon set of their own. */
    readonly icon: string;
    readonly emoji: readonly { readonly char: string; readonly words: string }[];
}

const of = (spec: string): { char: string; words: string }[] =>
    spec
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [char, ...words] = line.split(" ");
            return { char: char!, words: words.join(" ") };
        });

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
    {
        name: "Smileys",
        icon: "😀",
        emoji: of(`
            😀 grin happy smile
            😃 smile happy
            😄 laugh happy
            😁 beam grin
            😆 laugh squint
            😅 sweat laugh nervous
            🤣 rofl laughing
            😂 joy tears laughing
            🙂 slight smile
            🙃 upside down silly
            😉 wink
            😊 blush smile
            😇 innocent halo
            🥰 love hearts
            😍 heart eyes love
            🤩 star struck wow
            😘 kiss
            😗 kissing
            😚 kissing closed
            🥲 tear smile
            😋 yum tasty
            😛 tongue
            😜 wink tongue
            🤪 zany crazy
            😝 squint tongue
            🤑 money
            🤗 hug
            🤭 oops giggle
            🤫 shush quiet
            🤔 thinking hmm
            🤐 zipper quiet
            🤨 raised eyebrow doubt
            😐 neutral
            😑 expressionless
            😶 no mouth speechless
            😏 smirk
            😒 unamused
            🙄 eye roll
            😬 grimace awkward
            🤥 lying
            😌 relieved calm
            😔 pensive sad
            😪 sleepy
            🤤 drool
            😴 sleeping zzz
            😷 mask sick
            🤒 thermometer ill
            🤕 bandage hurt
            🤢 nauseated sick
            🤮 vomit sick
            🥵 hot heat
            🥶 cold freezing
            😵 dizzy
            🤯 mind blown exploding
            🤠 cowboy
            🥳 party celebrate
            😎 sunglasses cool
            🤓 nerd glasses
            🧐 monocle inspect
            😕 confused
            😟 worried
            🙁 frown
            😮 open mouth surprised
            😯 hushed
            😲 astonished shocked
            😳 flushed embarrassed
            🥺 pleading please
            😦 frowning
            😧 anguished
            😨 fearful
            😰 anxious sweat
            😥 sad relieved
            😢 cry sad
            😭 sobbing crying
            😱 scream fear
            😖 confounded
            😣 persevere
            😞 disappointed
            😓 downcast sweat
            😩 weary tired
            😫 tired
            🥱 yawn bored
            😤 triumph steam
            😡 angry rage
            😠 angry
            🤬 cursing swearing
            😈 devil mischief
            💀 skull dead
            💩 poop
            🤡 clown
            👻 ghost
            👽 alien
            🤖 robot bot
        `)
    },
    {
        name: "Gestures",
        icon: "👍",
        emoji: of(`
            👍 thumbs up yes good
            👎 thumbs down no bad
            👌 ok perfect
            🤌 pinched italian
            🤏 pinch small
            ✌️ peace victory
            🤞 fingers crossed luck
            🤟 love you
            🤘 rock horns
            🤙 call me shaka
            👈 point left
            👉 point right
            👆 point up
            👇 point down
            ☝️ index up
            ✋ raised hand stop
            🤚 back of hand
            🖐️ splayed hand
            🖖 vulcan spock
            👋 wave hello bye
            🤝 handshake deal
            🙏 pray thanks please
            ✍️ writing
            💪 muscle strong
            🦾 mechanical arm
            👏 clap applause
            🙌 raised hands celebrate
            👐 open hands
            🤲 palms up
            🫶 heart hands
            🤦 facepalm
            🤷 shrug
            🙇 bow sorry
            🙋 raising hand
            🧠 brain
            👀 eyes look
            👁️ eye
        `)
    },
    {
        name: "Hearts",
        icon: "❤️",
        emoji: of(`
            ❤️ red heart love
            🧡 orange heart
            💛 yellow heart
            💚 green heart
            💙 blue heart
            💜 purple heart
            🖤 black heart
            🤍 white heart
            🤎 brown heart
            💔 broken heart
            ❣️ heart exclamation
            💕 two hearts
            💞 revolving hearts
            💓 beating heart
            💗 growing heart
            💖 sparkling heart
            💘 heart arrow cupid
            💝 heart ribbon gift
            💟 heart decoration
            ♥️ heart suit
        `)
    },
    {
        name: "Objects",
        icon: "💻",
        emoji: of(`
            💻 laptop computer
            🖥️ desktop monitor
            ⌨️ keyboard
            🖱️ mouse
            🖨️ printer
            💾 floppy save
            💿 disc cd
            📀 dvd
            🗄️ file cabinet
            📁 folder
            📂 open folder
            📄 page document
            📃 page curl
            📊 bar chart
            📈 chart up
            📉 chart down
            📋 clipboard
            📌 pin
            📎 paperclip
            🔒 locked
            🔓 unlocked
            🔑 key
            🗝️ old key
            🔨 hammer
            🛠️ tools
            ⚙️ gear settings
            🧰 toolbox
            🧲 magnet
            🔌 plug
            🔋 battery
            📡 satellite antenna
            📱 phone mobile
            ☎️ telephone
            📞 receiver call
            📢 loudspeaker announce
            🔔 bell notification
            🔕 bell off muted
            ⏰ alarm clock
            ⌛ hourglass
            📅 calendar date
            📆 calendar
            🗓️ spiral calendar
            📦 package box
            🎁 gift present
            🏆 trophy win
            🥇 first place
            💡 bulb idea
            🔦 flashlight
            🕯️ candle
            🧹 broom cleanup
            🗑️ wastebasket delete
        `)
    },
    {
        name: "Signs",
        icon: "✅",
        emoji: of(`
            ✅ check done yes
            ☑️ ballot check
            ✔️ check mark
            ❌ cross no wrong
            ❎ cross mark
            ⭕ circle
            ⚠️ warning caution
            🚫 prohibited no
            ⛔ no entry
            🔴 red circle
            🟠 orange circle
            🟡 yellow circle
            🟢 green circle
            🔵 blue circle
            🟣 purple circle
            ⚫ black circle
            ⚪ white circle
            🔺 red triangle up
            🔻 red triangle down
            ❓ question
            ❔ white question
            ❗ exclamation
            ❕ white exclamation
            💬 speech balloon comment
            🗨️ left speech
            💭 thought balloon
            🔥 fire hot lit
            ⭐ star
            🌟 glowing star
            ✨ sparkles
            💥 collision boom
            💫 dizzy
            ⚡ zap lightning fast
            🎉 party popper celebrate
            🎊 confetti
            🚀 rocket ship launch
            🛑 stop sign
            🔍 magnifier search
            🔎 magnifier right
            ➕ plus add
            ➖ minus
            ➗ divide
            ♾️ infinity
            🔁 repeat loop
            🔄 arrows counterclockwise refresh
            ⏳ hourglass flowing
            🆕 new
            🆗 ok
            🆘 sos help
        `)
    },
    {
        name: "Nature",
        icon: "🌱",
        emoji: of(`
            🌱 seedling sprout
            🌲 evergreen tree
            🌳 tree
            🌴 palm tree
            🌵 cactus
            🌿 herb leaves
            ☘️ shamrock
            🍀 four leaf clover luck
            🍁 maple leaf
            🍂 fallen leaves
            🍃 leaf wind
            🌷 tulip
            🌸 cherry blossom
            🌹 rose
            🌺 hibiscus
            🌻 sunflower
            🌼 blossom
            🌞 sun face
            🌙 crescent moon
            ⭐ star
            ☀️ sun
            ⛅ sun behind cloud
            ☁️ cloud
            🌧️ rain
            ⛈️ storm
            🌈 rainbow
            ❄️ snowflake
            ⛄ snowman
            💧 droplet
            🌊 wave ocean
            🐶 dog
            🐱 cat
            🐭 mouse
            🐹 hamster
            🐰 rabbit
            🦊 fox
            🐻 bear
            🐼 panda
            🐨 koala
            🐯 tiger
            🦁 lion
            🐮 cow
            🐷 pig
            🐸 frog
            🐵 monkey
            🐔 chicken
            🐧 penguin
            🐦 bird
            🦆 duck
            🦉 owl
            🐝 bee
            🐛 bug
            🦋 butterfly
            🐢 turtle
            🐍 snake
            🐙 octopus
            🐳 whale
            🐬 dolphin
            🐟 fish
        `)
    },
    {
        name: "Food",
        icon: "☕",
        emoji: of(`
            ☕ coffee
            🍵 tea
            🧃 juice box
            🥤 cup straw
            🍺 beer
            🍻 cheers beers
            🥂 clink glasses
            🍷 wine
            🥃 whisky
            🍸 cocktail
            🍾 champagne
            🍶 sake
            🧋 bubble tea
            🍼 baby bottle
            🥛 milk
            🍎 apple
            🍐 pear
            🍊 orange tangerine
            🍋 lemon
            🍌 banana
            🍉 watermelon
            🍇 grapes
            🍓 strawberry
            🫐 blueberries
            🍒 cherries
            🍑 peach
            🥭 mango
            🍍 pineapple
            🥥 coconut
            🥑 avocado
            🍅 tomato
            🥕 carrot
            🌽 corn
            🌶️ hot pepper spicy
            🥔 potato
            🍞 bread
            🥐 croissant
            🥖 baguette
            🧀 cheese
            🥚 egg
            🍳 cooking fried egg
            🥞 pancakes
            🧇 waffle
            🥓 bacon
            🍔 hamburger burger
            🍟 fries
            🍕 pizza
            🌭 hot dog
            🥪 sandwich
            🌮 taco
            🌯 burrito
            🥗 salad
            🍝 pasta spaghetti
            🍜 ramen noodles
            🍣 sushi
            🍤 shrimp
            🍚 rice
            🍦 ice cream
            🍩 doughnut
            🍪 cookie
            🎂 birthday cake
            🍰 cake slice
            🍫 chocolate
            🍬 candy
            🍿 popcorn
            🧂 salt
        `)
    },
    {
        name: "Travel",
        icon: "✈️",
        emoji: of(`
            ✈️ airplane flight
            🚗 car
            🚕 taxi
            🚌 bus
            🚑 ambulance
            🚒 fire engine
            🚓 police car
            🚚 truck delivery
            🚲 bicycle bike
            🛴 scooter
            🏍️ motorcycle
            🚂 train
            🚇 metro subway
            🚉 station
            🚤 speedboat
            ⛵ sailboat
            🚢 ship
            🛰️ satellite
            🛸 ufo
            🚁 helicopter
            🏠 house home
            🏢 office building
            🏭 factory
            🏥 hospital
            🏦 bank
            🏨 hotel
            🏫 school
            🗼 tower
            🗽 statue liberty
            🌍 earth europe africa
            🌎 earth americas
            🌏 earth asia
            🗺️ world map
            🧭 compass
            ⛰️ mountain
            🏖️ beach
            🏝️ island
            🎪 circus tent
            🎡 ferris wheel
            🎢 roller coaster
        `)
    }
];

/** Every emoji that matches a typed term, flattened. Empty query gives nothing:
 *  the tabs are for browsing, and a search with no term is a browse. */
export function searchEmoji(query: string): { char: string; words: string }[] {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    const hits: { char: string; words: string }[] = [];
    for (const group of EMOJI_GROUPS) {
        for (const entry of group.emoji) {
            if (entry.words.includes(term) || entry.char === term) hits.push(entry);
        }
    }
    return hits;
}
