/** A thread's name: a calm adjective and an animal, with the animal's emoji
 * ("🦦 calm otter"). It is drawn once, when the thread is created, and kept
 * in its record (`Thread.name`); the title (the task, or what the user
 * renamed it to) and the id stay what they are, and a rename never changes
 * it. No model is asked: the name comes from the lists below, 64 × 64 = 4096
 * of them. Threads created before names were kept have none. */
import { createHash } from "node:crypto";

export interface ThreadName {
  /** The animal's emoji. */
  emoji: string;
  /** Two lowercase words, "calm otter". */
  words: string;
}

/** Adjectives that read well before any animal, and never as a thread's
 * state: no "busy", "sleepy", "ready", "slow" or lamp colors. */
export const ADJECTIVES: readonly string[] = `
calm quiet gentle brave bold clever wise kind merry jolly lucky nimble steady
patient curious cheerful cozy sunny misty frosty snowy breezy mellow tidy
plucky keen bright dapper humble earnest spry noble daring witty chipper
sturdy hardy polite modest serene dreamy lunar solar cosmic golden silver
velvet copper coral indigo cobalt ivory jade maple cedar mossy woolly fuzzy
fluffy snug starry rustic jaunty perky
`.split(/\s+/).filter(Boolean);

/** Each animal with its own emoji (Unicode 13 at the newest). */
export const ANIMALS: ReadonlyArray<readonly [string, string]> = [
  ["otter", "🦦"], ["fox", "🦊"], ["owl", "🦉"], ["badger", "🦡"], ["beaver", "🦫"], ["hedgehog", "🦔"],
  ["rabbit", "🐇"], ["squirrel", "🐿️"], ["deer", "🦌"], ["bison", "🦬"], ["wolf", "🐺"], ["bear", "🐻"],
  ["panda", "🐼"], ["koala", "🐨"], ["raccoon", "🦝"], ["squid", "🦑"], ["tiger", "🐅"], ["lion", "🦁"],
  ["zebra", "🦓"], ["giraffe", "🦒"], ["elephant", "🐘"], ["camel", "🐫"], ["llama", "🦙"], ["kangaroo", "🦘"],
  ["penguin", "🐧"], ["parrot", "🦜"], ["flamingo", "🦩"], ["swan", "🦢"], ["peacock", "🦚"], ["eagle", "🦅"],
  ["duck", "🦆"], ["dove", "🕊️"], ["whale", "🐋"], ["dolphin", "🐬"], ["seal", "🦭"], ["octopus", "🐙"],
  ["crab", "🦀"], ["lobster", "🦞"], ["turtle", "🐢"], ["frog", "🐸"], ["lizard", "🦎"], ["beetle", "🪲"],
  ["butterfly", "🦋"], ["bee", "🐝"], ["ladybug", "🐞"], ["cat", "🐈"], ["dog", "🐕"], ["horse", "🐎"],
  ["unicorn", "🦄"], ["dragon", "🐉"], ["mouse", "🐁"], ["hamster", "🐹"], ["monkey", "🐒"], ["gorilla", "🦍"],
  ["hippo", "🦛"], ["rhino", "🦏"], ["sheep", "🐑"], ["goat", "🐐"], ["ox", "🐂"], ["rooster", "🐓"],
  ["shark", "🦈"], ["pufferfish", "🐡"], ["mammoth", "🦣"], ["bat", "🦇"],
];

/** The `attempt`th name drawn for a thread: from its random id, so a test
 * can pin it, and a redraw (another open thread has the name) is the next. */
export function drawThreadName(id: string, attempt = 0): ThreadName {
  const digest = createHash("sha256").update(attempt ? `${id}:${attempt}` : id).digest();
  const adjective = ADJECTIVES[digest.readUInt32BE(0) % ADJECTIVES.length]!;
  const [animal, emoji] = ANIMALS[digest.readUInt32BE(4) % ANIMALS.length]!;
  return { emoji, words: `${adjective} ${animal}` };
}

/** A new thread's name: the first drawn that no open thread has (`taken`
 * holds their words); after 32 draws, the last, taken or not. */
export function newThreadName(id: string, taken: ReadonlySet<string>): ThreadName {
  let name = drawThreadName(id);
  for (let attempt = 1; attempt < 32 && taken.has(name.words); attempt++) name = drawThreadName(id, attempt);
  return name;
}

/** "🦦 calm otter", for text; empty when there is none. */
export function threadNameText(name: ThreadName | null | undefined): string {
  return name ? `${name.emoji} ${name.words}` : "";
}
