// Jaro-Winkler string similarity. Returns a value in [0, 1] where 1 is
// an exact match. Used for fuzzy distributor↔Veeva account name matching.
//
// Why JW (vs Levenshtein, trigram, token Jaccard):
//   - Tuned for short strings (names, identifiers)
//   - Boosts scores for shared prefixes (good for org names: "MEMORIAL
//     HEALTH SYS" vs "Memorial Health System")
//   - Pure-JS, ~50 lines, no deps
//   - Same family of algos used by pg_trgm-style search and the standard
//     postgres `similarity()` function
//
// Normalization (do BEFORE calling jaroWinkler) handles case, punctuation,
// and corporate suffixes that add noise without information.

const CORPORATE_SUFFIXES = [
  "INC", "LLC", "LTD", "LP", "LLP", "PA", "PC", "PLLC", "CORP", "CO",
  "COMPANY", "GROUP", "GRP", "PHARMACY", "PHARM", "RX",
];

// Normalize a name for matching: uppercase, strip punctuation/extra spaces,
// drop trailing corporate suffixes ("Memorial Health Sys, LLC" → "MEMORIAL
// HEALTH SYS"). Conservative — only drops suffixes at the end so we don't
// mangle real words.
export function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  let normalized = s
    .toUpperCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Drop trailing suffixes like "MEMORIAL HEALTH LLC" → "MEMORIAL HEALTH"
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of CORPORATE_SUFFIXES) {
      const tail = ` ${suffix}`;
      if (normalized.endsWith(tail)) {
        normalized = normalized.slice(0, -tail.length).trim();
        changed = true;
      }
    }
  }
  return normalized;
}

// Jaro similarity (precursor to Jaro-Winkler).
function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);

  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (
    matches / s1.length +
    matches / s2.length +
    (matches - transpositions) / matches
  ) / 3;
}

// Jaro-Winkler: jaro + bonus for shared prefix (capped at 4 chars, scale 0.1).
// Threshold of 0.7 is the standard cutoff before applying the prefix boost.
export function jaroWinkler(s1: string, s2: string): number {
  const j = jaro(s1, s2);
  if (j < 0.7) return j;

  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return j + prefix * 0.1 * (1 - j);
}
