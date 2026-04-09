import nlp from "compromise";

// POS-tagged closed-class words compromise can identify. Filtering on these
// gives us language-aware stopword removal without hand-maintaining a list.
const CLOSED_CLASS_POS_SELECTOR = "#Determiner, #Preposition, #Conjunction, #Pronoun, #Auxiliary, #Copula";

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
