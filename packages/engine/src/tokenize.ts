import nlp from "compromise";

// POS-tagged closed-class words compromise can identify. Filtering on these
// gives us language-aware stopword removal without hand-maintaining a list.
const CLOSED_CLASS_POS_SELECTOR = "#Determiner, #Preposition, #Conjunction, #Pronoun, #Auxiliary, #Copula";

/**
 * Closed-class POS tags that carry no domain semantics. A name consisting
 * entirely of these tags is a stop word in any corpus.
 */
export const CLOSED_CLASS_POS_TAGS = new Set(["Determiner", "Preposition", "Conjunction", "Pronoun", "Auxiliary", "Copula", "Modal"]);

/**
 * High-frequency English words that compromise tags as content POS (verbs,
 * adjectives, adverbs) but carry no domain semantics in any corpus. These are
 * always rejected by {@link isValidTermName} regardless of the configurable
 * deny-list — they are junk concepts in every domain.
 *
 * This list is deliberately small and conservative: only words that appear as
 * top-degree graph nodes across different corpora, indicating they are
 * universally generic rather than domain-specific.
 */
export const ENGLISH_STOPWORDS = new Set([
  // High-frequency verbs that don't encode domain semantics
  "have",
  "like",
  "know",
  "want",
  "think",
  "need",
  "look",
  "try",
  "give",
  "use",
  "get",
  "getting",
  "got",
  "make",
  "making",
  "come",
  "take",
  "put",
  "let",
  "say",
  "said",
  "goes",
  "went",
  "done",
  "doing",
  "being",
  "been",
  "needs",
  // Generic pronouns / quantifiers compromise doesn't flag as closed-class
  "what",
  "there",
  "every",
  "anything",
  "something",
  "everything",
  "nothing",
  // Generic adverbs / discourse fillers
  "just",
  "right",
  "then",
  "going",
  "more",
  "yeah",
  "really",
  "actually",
  "very",
  "much",
  "well",
  "still",
  "also",
  "even",
  "already",
  "always",
  "never",
  // Generic nouns that never encode domain meaning
  "thing",
  "things",
  "way",
  "lot",
  "back",
  "day",
  "long",
  // Common adjectives that don't discriminate topics
  "good"
]);

function splitTermToTokens(term: string, tokens: string[]): void {
  // compromise occasionally returns multi-word terms (e.g. "rate limit");
  // split them back into individual lowercase alphanumeric tokens so the
  // result is consistent with how our search index and frequency counters
  // want to consume them.
  for (const piece of term.split(/[^a-z0-9-]+/)) {
    const trimmed = piece.replace(/^-+|-+$/g, "");
    if (trimmed.length >= 2) {
      tokens.push(trimmed);
    }
  }
}

/**
 * Compromise-backed tokenizer. Returns lowercase term strings using
 * compromise's linguistic tokenization (handles contractions, hyphenation,
 * and most non-ASCII), with a narrow regex fallback when the NLP stack
 * returns nothing (e.g. very short strings, non-English text, or edge
 * cases that confuse the grammar).
 *
 * This is the shared replacement for ad-hoc `[a-z][a-z0-9-]{3,}` style
 * regex tokenization that used to live in analysis.ts and search.ts.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  try {
    const terms = nlp(lower).terms().out("array") as string[];
    const tokens: string[] = [];
    for (const term of terms) {
      splitTermToTokens(term, tokens);
    }
    if (tokens.length > 0) {
      return tokens;
    }
  } catch {
    // Fall through to the regex fallback below.
  }
  return lower.match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
}

/**
 * Returns tokens suitable for content analysis (concept frequency counting,
 * summarization). Drops closed-class words (determiners, prepositions,
 * conjunctions, pronouns, auxiliaries, copulas) via compromise POS tagging
 * instead of a hand-maintained stopword set, and enforces a minimum length.
 */
export function contentTokens(text: string, minLength = 4): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  try {
    // Use compromise to strip closed-class POS tags; the remaining document
    // is the content words (nouns, verbs, adjectives, adverbs, etc.).
    const contentDoc = nlp(lower).not(CLOSED_CLASS_POS_SELECTOR);
    const terms = contentDoc.terms().out("array") as string[];
    for (const term of terms) {
      splitTermToTokens(term, tokens);
    }
  } catch {
    // fall through to the regex fallback below
  }
  if (tokens.length === 0) {
    // Fallback: narrow regex split, no POS awareness.
    for (const piece of lower.match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []) {
      tokens.push(piece);
    }
  }
  return tokens.filter((token) => token.length >= minLength);
}

export function isValidTermName(name: string, denyList?: ReadonlySet<string>): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;

  const lower = trimmed.toLowerCase();
  if (ENGLISH_STOPWORDS.has(lower)) return false;
  if (denyList?.has(lower)) return false;

  // Reject compound names starting with a deny-list word — these are NLP
  // artifacts where compromise prepends a structural label (e.g. "Transcript
  // If", "Transcript What's") rather than extracting a real entity.
  if (denyList && /[\s\-_]/.test(trimmed)) {
    const firstWord = lower.split(/[\s\-_]+/)[0];
    if (firstWord && denyList.has(firstWord)) return false;
  }

  // Reject structural fragments — these are parsing artifacts, not terms
  if (trimmed.startsWith("[")) return false;
  if (trimmed.startsWith("\u201C") || trimmed.startsWith("\u201D") || trimmed.startsWith('"')) return false;
  if (/\([A-Z]{2,}[^)]*$/.test(trimmed)) return false;
  if (/[\u2026\u2014\u2013].*\S/.test(trimmed)) return false;
  if (/^[A-Z][a-z]+\s[A-Z][a-z]+\.$/.test(trimmed)) return false;
  if (/^I\u2019[mve]|^I'm|^I've/i.test(trimmed)) return false;

  // Reject names consisting entirely of closed-class POS tags
  try {
    const doc = nlp(trimmed);
    const terms = doc.terms().termList();
    if (terms.length === 0) return false;
    if (terms.every((term) => term.tags && [...term.tags].some((tag) => CLOSED_CLASS_POS_TAGS.has(tag)))) return false;
  } catch {
    return trimmed.length >= 3;
  }

  return true;
}
