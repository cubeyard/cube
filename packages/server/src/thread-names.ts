/** A thread's name: a calm adjective and an animal, with the animal's emoji
 * ("🦦 calm otter"), in the spirit of uniichat's agent names. It is chosen
 * once, when the thread is created, from the thread's id, and kept in its
 * record; the title (the task, or what the user renamed it to) and the id
 * stay what they are. No model is asked: the name is drawn from the lists
 * below, 64 × 64 = 4096 of them.
 *
 * The lists are fixed: a thread created before names were kept has none in
 * its record, and reads the one its id gives here (`threadIdentity`), so
 * changing a word renames those threads. Add a list beside these instead. */
import { createHash } from "node:crypto";

export interface ThreadIdentity {
  /** Two lowercase words, "calm otter". */
  name: string;
  /** The animal's emoji. */
  emoji: string;
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

/** The name the thread's id gives, or, for `attempt` > 0, the next one
 * drawn after it (another taken it). */
export function threadIdentity(id: string, attempt = 0): ThreadIdentity {
  const digest = createHash("sha256").update(attempt ? `${id}:${attempt}` : id).digest();
  const adjective = ADJECTIVES[digest.readUInt32BE(0) % ADJECTIVES.length]!;
  const [animal, emoji] = ANIMALS[digest.readUInt32BE(4) % ANIMALS.length]!;
  return { name: `${adjective} ${animal}`, emoji };
}

/** A new thread's name: the first its id gives that no name in `taken`
 * (the open threads') has; after 32 draws, the last, taken or not. */
export function newThreadIdentity(id: string, taken: ReadonlySet<string>): ThreadIdentity {
  let identity = threadIdentity(id);
  for (let attempt = 1; attempt < 32 && taken.has(identity.name); attempt++) identity = threadIdentity(id, attempt);
  return identity;
}

/** "🦦 calm otter", for text; empty when there is none. */
export function identityText(identity: ThreadIdentity | undefined): string {
  return identity ? `${identity.emoji} ${identity.name}` : "";
}
