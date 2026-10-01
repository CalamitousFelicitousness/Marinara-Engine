// ──────────────────────────────────────────────
// The starter setting kits (worldgen W0): broad families of setting, never franchises, that the
// model starts from when it writes a world's kit and that a game falls back on when no connection
// can write one. The first set (approved 2026-10-01): high fantasy, wuxia and xianxia, modern day
// (with slice of life), modern supernatural, the 1920s, cyberpunk, space opera, post-apocalyptic.
// Names come later (worldgen W2); a culture here says only how its people are named.
// ──────────────────────────────────────────────
import type { WorldKitInput } from "../../schemas/world-kit.schema.js";

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** Words with ids made from them: "thieves' guild" is `thieves_guild`, "café" is `cafe`. A word
 *  with no Latin letter or digit in it (村, город) is known by its place in the list instead. */
export const worldKitEntries = (words: readonly string[]) =>
  words.map((label, index) => {
    const slug = label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 36)
      .replace(/^_+|_+$/g, "");
    return { id: !slug ? `entry_${index + 1}` : /^[0-9]/.test(slug) ? `n_${slug}` : slug, label };
  });
const named = (...words: string[]) => worldKitEntries(words);

const highFantasy: WorldKitInput = {
  schemaVersion: 1,
  id: "high_fantasy",
  label: "High fantasy",
  summary:
    "Kingdoms and provinces, walled towns and villages on old roads, guilds and temples and noble houses, magic that is rare and real, and monsters beyond the fields.",
  scale: "realm",
  layers: [
    { id: "realm", label: "realm" },
    { id: "province", label: "province" },
    { id: "settlement", label: "settlement", settlements: true },
    { id: "quarter", label: "quarter" },
  ],
  sizes: named("hamlet", "village", "town", "city", "capital"),
  groupKinds: named(
    "household",
    "shop",
    "guild",
    "temple",
    "noble house",
    "knightly order",
    "mage circle",
    "thieves' guild",
    "village council",
    "merchant company",
    "mercenary band",
    "monastery",
  ),
  placeTags: named(
    "port",
    "mine",
    "market",
    "temple",
    "keep",
    "ruin",
    "crossroads",
    "farmland",
    "forest edge",
    "mage tower",
    "border fort",
    "holy site",
  ),
  travel: named("road", "river", "sea lane", "mountain pass", "forest track"),
  calendar: { year: "year", day: "day" },
  change: {
    kinds: {
      everyday: { label: "seasons, fairs and feast days", on: true },
      lives: { label: "friendships, marriages and apprenticeships", on: true },
      fortunes: { label: "trades, harvests and shops that rise and fall", on: true },
      rivalry: { label: "rivalries between houses and guilds", on: true },
      leadership: { label: "successions and new lords", on: true },
      crime: { label: "thieves, bandits and monsters on the roads", on: true },
      conflict: { label: "feuds, raids and wars between realms", on: true },
      catastrophe: { label: "plagues, famines and fallen cities", on: true },
    },
    pace: "steady",
  },
  cultures: [
    {
      id: "heartland",
      label: "heartland folk",
      naming:
        "Invented names of the setting's own sound, not borrowed from any real language: a given name, and a family or house name for those who have one; commoners are often known by trade or home village.",
    },
    {
      id: "far_peoples",
      label: "far peoples",
      naming:
        "Each people beyond the borders has its own naming custom, invented for the setting and kept consistent: some name children after ancestors, some use clan names first, some take new names at coming of age.",
    },
  ],
};

const wuxia: WorldKitInput = {
  schemaVersion: 1,
  id: "wuxia_xianxia",
  label: "Wuxia and xianxia",
  summary:
    "An empire of provinces and prefectures, market towns and teahouses, and the jianghu beside it: martial sects on their mountains, sworn brothers, escort agencies, feuds and secret manuals; with xianxia, cultivation and flying swords.",
  scale: "realm",
  layers: [
    { id: "empire", label: "empire" },
    { id: "province", label: "province" },
    { id: "prefecture", label: "prefecture" },
    { id: "town", label: "town", settlements: true },
  ],
  sizes: named("village", "market town", "county seat", "prefecture city", "capital"),
  groupKinds: named(
    "sect",
    "clan",
    "martial school",
    "escort agency",
    "beggars' brotherhood",
    "imperial court",
    "magistrate's office",
    "merchant house",
    "inn",
    "teahouse",
    "family",
    "cultivation sect",
  ),
  placeTags: named(
    "sect gate",
    "sacred mountain",
    "market",
    "inn",
    "teahouse",
    "river port",
    "magistrate's yamen",
    "temple",
    "spirit vein",
    "secret realm",
    "bamboo forest",
    "border pass",
  ),
  travel: named("road", "river", "canal", "mountain path", "qinggong over the rooftops", "flying sword"),
  calendar: {
    year: "year of the reign",
    day: "day",
    months: [
      "First Month",
      "Second Month",
      "Third Month",
      "Fourth Month",
      "Fifth Month",
      "Sixth Month",
      "Seventh Month",
      "Eighth Month",
      "Ninth Month",
      "Tenth Month",
      "Eleventh Month",
      "Twelfth Month",
    ],
    era: "reign era",
  },
  change: {
    kinds: {
      everyday: { label: "festivals, markets and the turning seasons", on: true },
      lives: { label: "sworn brotherhoods, marriages and disciples taken", on: true },
      fortunes: { label: "inns, escort agencies and families rising and falling", on: true },
      rivalry: { label: "rivalries between sects and schools, tournaments won", on: true },
      leadership: { label: "a new sect master, a new magistrate", on: true },
      crime: { label: "bandits on the roads, stolen manuals, poisonings", on: true },
      conflict: { label: "jianghu feuds, sect wars and rebellions", on: true },
      catastrophe: { label: "floods, plagues and fallen dynasties", on: true },
    },
    pace: "steady",
  },
  cultures: [
    {
      id: "central_plains",
      label: "people of the Central Plains",
      naming:
        "Family name first (one syllable, sometimes two), then a given name of one or two syllables; scholars and nobles may have a courtesy name, and famous fighters an epithet the jianghu gives them. Varied and fitting, never the most famous names from classic novels.",
    },
    {
      id: "borderlands",
      label: "peoples of the borderlands",
      naming:
        "The peoples of the hills, steppes and coasts beyond the plains have their own languages and naming customs, which may put a family name last or use none. Written with respect, as people with their own ways, never as exotic villains.",
    },
  ],
};

const modernDay: WorldKitInput = {
  schemaVersion: 1,
  id: "modern_day",
  label: "Modern day",
  summary:
    "The present day, from a quiet village to a city: neighbors, schools, cafés and shops, jobs and festivals, friendships and small rivalries. Gentle by default, for slice of life.",
  scale: "town",
  layers: [
    { id: "country", label: "country" },
    { id: "region", label: "region" },
    { id: "city", label: "city", settlements: true },
    { id: "neighborhood", label: "neighborhood" },
  ],
  sizes: named("village", "small town", "town", "city", "metropolis"),
  groupKinds: named(
    "family",
    "household",
    "café",
    "shop",
    "restaurant",
    "school club",
    "company",
    "band",
    "sports team",
    "neighborhood association",
    "community center",
    "local council",
  ),
  placeTags: named(
    "train station",
    "park",
    "school",
    "shopping street",
    "harbor",
    "hospital",
    "library",
    "place of worship",
    "market",
    "beach",
    "festival grounds",
    "office district",
  ),
  travel: named("walking", "bicycle", "bus", "train", "car", "ferry", "plane"),
  calendar: { year: "year", day: "day", months },
  change: {
    kinds: {
      everyday: { label: "seasons, festivals and school terms", on: true },
      lives: { label: "friendships, crushes, new neighbors and moving away", on: true },
      fortunes: { label: "shops opening and closing, new jobs, renovations", on: true },
      rivalry: { label: "rival cafés, school contests and friendly competition", on: true },
      leadership: { label: "elections, a new principal, a new manager", on: true },
      crime: { label: "thefts, scams and trouble", on: false },
      conflict: { label: "violence and feuds", on: false },
      catastrophe: { label: "disasters and epidemics", on: false },
    },
    pace: "slow",
  },
  cultures: [
    {
      id: "locals",
      label: "locals",
      naming:
        "Names fit the country and region the player chose, as people there are named today, varied by age, family background and migration, with the nicknames and given names locals actually use.",
    },
  ],
};

const modernSupernatural: WorldKitInput = {
  schemaVersion: 1,
  id: "modern_supernatural",
  label: "Modern supernatural",
  summary:
    "The present day with something hidden in it: covens, old courts of the night, hunters and things that should not be, living beside people who never notice.",
  scale: "town",
  layers: [
    { id: "country", label: "country" },
    { id: "region", label: "region" },
    { id: "city", label: "city", settlements: true },
    { id: "neighborhood", label: "neighborhood" },
  ],
  sizes: named("village", "small town", "town", "city", "metropolis"),
  groupKinds: named(
    "family",
    "household",
    "shop",
    "company",
    "police department",
    "coven",
    "court of the night",
    "hunters' order",
    "pack",
    "occult shop",
    "secret society",
    "church",
  ),
  placeTags: named(
    "haunted house",
    "ley line",
    "hidden market",
    "cemetery",
    "old church",
    "nightclub",
    "train station",
    "park",
    "hospital",
    "library",
    "abandoned factory",
    "woods at the edge of town",
  ),
  travel: named("walking", "bus", "train", "car", "plane", "hidden paths"),
  calendar: { year: "year", day: "day", months },
  change: {
    kinds: {
      everyday: { label: "seasons, festivals and the town's routines", on: true },
      lives: { label: "friendships, romances and new arrivals", on: true },
      fortunes: { label: "businesses and families doing well or badly", on: true },
      rivalry: { label: "rivalries between covens, courts and packs", on: true },
      leadership: { label: "a new head of a coven or court, an election", on: true },
      crime: { label: "disappearances, thefts and things seen at night", on: true },
      conflict: { label: "wars between the hidden factions", on: true },
      catastrophe: { label: "outbreaks and incursions from beyond", on: true },
    },
    pace: "steady",
  },
  cultures: [
    {
      id: "mortals",
      label: "mortals",
      naming:
        "Names fit the country and region the player chose, as people there are named today, varied by age, family background and migration.",
    },
    {
      id: "hidden",
      label: "the hidden",
      naming:
        "Old beings keep the names of the place and century they were born in, younger ones use modern names, and some go by a title or a name given by their kind.",
    },
  ],
};

const twenties: WorldKitInput = {
  schemaVersion: 1,
  id: "the_1920s",
  label: "The 1920s",
  summary:
    "The years after the Great War: jazz and speakeasies, newspapers and rail depots, unions and political machines, bootleggers and the people who chase them.",
  scale: "region",
  layers: [
    { id: "country", label: "country" },
    { id: "state", label: "state" },
    { id: "city", label: "city", settlements: true },
    { id: "district", label: "district" },
  ],
  sizes: named("whistle-stop", "small town", "town", "city", "metropolis"),
  groupKinds: named(
    "family",
    "speakeasy",
    "newspaper",
    "police precinct",
    "crime family",
    "union",
    "church",
    "jazz band",
    "university department",
    "department store",
    "political machine",
    "social club",
  ),
  placeTags: named(
    "rail depot",
    "speakeasy",
    "dockyard",
    "theater",
    "university",
    "factory",
    "mansion",
    "jazz club",
    "harbor",
    "farmland",
    "boarding house",
    "city hall",
  ),
  travel: named("walking", "streetcar", "motorcar", "rail", "steamship", "airplane"),
  calendar: { year: "year", day: "day", months },
  change: {
    kinds: {
      everyday: { label: "seasons, fairs and the society pages", on: true },
      lives: { label: "friendships, marriages, newcomers and departures", on: true },
      fortunes: { label: "booms and busts, new businesses and closures", on: true },
      rivalry: { label: "rival papers, clubs and political factions", on: true },
      leadership: { label: "elections, a new boss, a new police chief", on: true },
      crime: { label: "bootlegging, robberies and corruption", on: true },
      conflict: { label: "gang wars, strikes and riots", on: true },
      catastrophe: { label: "floods, fires and epidemics", on: true },
    },
    pace: "steady",
  },
  cultures: [
    {
      id: "locals",
      label: "people of the place",
      naming:
        "Names as people of the place and the decade were named, by family background and immigration, for the 1920s were a time of many arrivals; never as stereotypes.",
    },
  ],
};

const cyberpunk: WorldKitInput = {
  schemaVersion: 1,
  id: "cyberpunk",
  label: "Cyberpunk",
  summary:
    "A megacity of districts and stacked blocks under corporate towers: gangs, fixers, netrunners, street clinics and night markets, and everybody owing somebody.",
  scale: "town",
  layers: [
    { id: "megacity", label: "megacity" },
    { id: "district", label: "district" },
    { id: "block", label: "block", settlements: true },
    { id: "building", label: "building" },
  ],
  sizes: named("squat", "stack", "block", "arcology"),
  groupKinds: named(
    "corporation",
    "gang",
    "fixer's network",
    "netrunner crew",
    "street clinic",
    "media feed",
    "nomad family",
    "security firm",
    "city council",
    "food stall",
    "household",
    "union",
  ),
  placeTags: named(
    "night market",
    "clinic",
    "corporate tower",
    "data haven",
    "combat zone",
    "maglev station",
    "rooftop garden",
    "scrapyard",
    "club",
    "capsule hotel",
  ),
  travel: named("walking", "metro", "maglev", "aerodyne", "motorbike"),
  calendar: { year: "year", day: "day", months },
  change: {
    kinds: {
      everyday: { label: "the city's rhythm, its markets and its feeds", on: true },
      lives: { label: "crews forming and breaking, debts and loyalties", on: true },
      fortunes: { label: "corporations, gangs and stalls rising and falling", on: true },
      rivalry: { label: "corporate rivalries and turf disputes", on: true },
      leadership: { label: "a new boss, a hostile takeover, a council vote", on: true },
      crime: { label: "heists, data theft and disappearances", on: true },
      conflict: { label: "gang wars, corporate strikes and riots", on: true },
      catastrophe: { label: "blackouts, plagues and collapsing arcologies", on: true },
    },
    pace: "quick",
  },
  cultures: [
    {
      id: "street",
      label: "people of the street",
      naming:
        "Names from every culture that came to the city, mixed: given and family names from many languages, and handles or street names that can matter more than legal names.",
    },
  ],
};

const spaceOpera: WorldKitInput = {
  schemaVersion: 1,
  id: "space_opera",
  label: "Space opera",
  summary:
    "A sector of star systems joined by jump lanes: capital worlds and frontier colonies, noble houses and guilds, fleets and crews, and ruins older than anyone.",
  scale: "sector",
  layers: [
    { id: "sector", label: "sector" },
    { id: "system", label: "system" },
    { id: "world", label: "world or station", settlements: true },
    { id: "district", label: "district" },
  ],
  sizes: named("outpost", "colony", "habitat", "city", "capital world"),
  groupKinds: named(
    "noble house",
    "guild",
    "fleet",
    "corporation",
    "religious order",
    "ship's crew",
    "colony council",
    "smuggling ring",
    "academy",
    "embassy",
    "household",
    "mining consortium",
  ),
  placeTags: named(
    "spaceport",
    "shipyard",
    "mining",
    "agriculture",
    "capital",
    "ancient ruins",
    "jump gate",
    "research station",
    "trade hub",
    "frontier",
  ),
  travel: named("jump lane", "shuttle", "freighter route", "gate"),
  calendar: { year: "standard year", day: "standard day", era: "era" },
  change: {
    kinds: {
      everyday: { label: "trade seasons, festivals and the news of the lanes", on: true },
      lives: { label: "crews, alliances, marriages and new arrivals", on: true },
      fortunes: { label: "worlds, houses and companies rising and falling", on: true },
      rivalry: { label: "rivalries between houses, guilds and fleets", on: true },
      leadership: { label: "successions, elections and new admirals", on: true },
      crime: { label: "piracy, smuggling and espionage", on: true },
      conflict: { label: "blockades, raids and wars between powers", on: true },
      catastrophe: { label: "plagues, dying stars and lost worlds", on: true },
    },
    pace: "steady",
  },
  cultures: [
    {
      id: "core",
      label: "core worlds",
      naming:
        "Names grown from many Earth languages over centuries, worn and blended, invented for the setting and consistent within a world.",
    },
    {
      id: "frontier",
      label: "frontier",
      naming:
        "Frontier families keep short practical names and call signs, and some worlds have naming customs of their own the setting invents.",
    },
  ],
};

const postApocalyptic: WorldKitInput = {
  schemaVersion: 1,
  id: "post_apocalyptic",
  label: "Post-apocalyptic",
  summary:
    "After the fall: camps and holds among the ruins, caravans on the old highways, water and fuel worth fighting for, and new ways growing out of the old.",
  scale: "region",
  layers: [
    { id: "region", label: "region" },
    { id: "zone", label: "zone" },
    { id: "settlement", label: "settlement", settlements: true },
    { id: "quarter", label: "quarter" },
  ],
  sizes: named("camp", "hold", "settlement", "town", "city-state"),
  groupKinds: named(
    "clan",
    "scavenger crew",
    "caravan",
    "militia",
    "cult",
    "trading post",
    "raiders",
    "water council",
    "mechanics' guild",
    "family",
    "school",
    "clinic",
  ),
  placeTags: named(
    "water source",
    "scrapyard",
    "old highway",
    "dead zone",
    "bunker",
    "market",
    "fortified gate",
    "farm",
    "ruined city",
    "fuel depot",
  ),
  travel: named("on foot", "caravan trail", "old highway", "river barge"),
  calendar: { year: "year after the fall", day: "day" },
  change: {
    kinds: {
      everyday: { label: "seasons, markets and the work of staying alive", on: true },
      lives: { label: "families, friendships, newcomers and the lost", on: true },
      fortunes: { label: "holds and caravans growing or failing", on: true },
      rivalry: { label: "rivalries over water, salvage and routes", on: true },
      leadership: { label: "new leaders, councils and warlords", on: true },
      crime: { label: "theft, raids on caravans and missing people", on: true },
      conflict: { label: "raids, feuds and wars between holds", on: true },
      catastrophe: { label: "droughts, storms and sickness", on: true },
    },
    pace: "quick",
  },
  cultures: [
    {
      id: "survivors",
      label: "survivors",
      naming:
        "Old-world names worn down over generations, nicknames earned from deeds, and names from the cultures that held on in the region.",
    },
  ],
};

/** The starter kits, in the order the picker shows them. */
export const WORLD_STARTER_KITS: readonly WorldKitInput[] = Object.freeze([
  highFantasy,
  wuxia,
  modernDay,
  modernSupernatural,
  twenties,
  cyberpunk,
  spaceOpera,
  postApocalyptic,
]);
