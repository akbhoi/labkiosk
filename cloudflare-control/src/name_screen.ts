/**
 * Screening of the names an organization shows the public: its console
 * address (the subdomain) and its organization name.
 *
 * This is a word list, not a judgment: deterministic, free, and the same
 * answer every time, so a refusal can be explained and reviewed. It is the
 * first line; the AI moderation added later only sees what passes here.
 *
 * A name is split into words on anything that is not a letter or digit, and
 * each word is compared after undoing common character swaps (`p0rn`,
 * `s3x`). Most terms match a whole word only, because a substring match on a
 * short term refuses real places ("Essex", "Scunthorpe"); the few terms that
 * never occur inside an ordinary word also match inside one (`hotpornsite`).
 *
 * The refusal never names the term, so the list cannot be probed one word at
 * a time.
 */

/** Matched inside any word: none of these occurs in an ordinary word. */
const BLOCKED_ANYWHERE: readonly string[] = [
  "porn",
  "xxx",
  "hentai",
  "nsfw",
  "onlyfans",
  "fuck",
  "dildo",
  "blowjob",
  "handjob",
  "cumshot",
  "bestiality",
  "pedophil",
  "paedophil",
  "madarchod",
  "behenchod",
  "bhenchod",
  "bhosdi",
  "chutiya"
];

/** Matched as a whole word only. */
const BLOCKED_WORDS: ReadonlySet<string> = new Set([
  "sex",
  "sexy",
  "nude",
  "nudes",
  "boob",
  "boobs",
  "milf",
  "hooker",
  "camgirl",
  "camgirls",
  "pussy",
  "cunt",
  "slut",
  "whore",
  "bitch",
  "shit",
  "rape",
  "nazi",
  "kkk",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "gaand",
  "gandu"
]);

/**
 * Names whose holders are targets for impersonation: banks, payment apps and
 * government services people are phished in the name of. A whole word only,
 * so "Sbitech" passes but "sbi-netbanking" does not.
 */
const IMPERSONATED_WORDS: ReadonlySet<string> = new Set([
  "sbi",
  "hdfc",
  "icici",
  "axisbank",
  "kotak",
  "paytm",
  "phonepe",
  "gpay",
  "npci",
  "rbi",
  "uidai",
  "aadhaar",
  "aadhar",
  "irctc",
  "epfo",
  "incometax",
  "paypal"
]);

/** Character swaps that hide a word: the digit or symbol read as the letter it stands for. */
const LOOKALIKES: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s" };

function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9@$]+/)
    .filter(Boolean);
}

/** A word with look-alike characters read as letters and runs of one letter collapsed ("fuuuck"). */
function plain(word: string): string {
  const swapped = Array.from(word, (c) => LOOKALIKES[c] ?? c).join("");
  return swapped.replace(/([a-z])\1{2,}/g, "$1");
}

/**
 * The words, with a run of single letters read as one word too: "p-o-r-n"
 * is the word it spells. Only runs of single letters are joined, because
 * joining whole words finds terms across their boundary ("Max X Xavier").
 */
function spelledOut(list: string[]): string[] {
  const out = [...list];
  let run = "";
  for (const word of [...list, ""]) {
    if (word.length === 1) {
      run += word;
      continue;
    }
    if (run.length > 1) out.push(run);
    run = "";
  }
  return out;
}

export type NameProblem = "blocked" | "impersonation";

/**
 * Whether `text` (an address or an organization name) carries a blocked term,
 * and which kind; null when it passes. A word is tested as written and with
 * look-alikes undone.
 */
export function screenName(text: string): NameProblem | null {
  const forms = new Set<string>();
  for (const word of spelledOut(words(text))) {
    forms.add(word);
    forms.add(plain(word));
  }
  for (const form of forms) {
    if (BLOCKED_ANYWHERE.some((term) => form.includes(term))) return "blocked";
  }
  for (const form of forms) {
    if (BLOCKED_WORDS.has(form)) return "blocked";
    if (IMPERSONATED_WORDS.has(form)) return "impersonation";
  }
  return null;
}

/** What the customer is told: the same for every kind, so the list cannot be probed. */
export const ADDRESS_REFUSAL = "That address is not available. Choose another.";
export const NAME_REFUSAL = "That organization name cannot be used. If you think this is a mistake, write to support.";
