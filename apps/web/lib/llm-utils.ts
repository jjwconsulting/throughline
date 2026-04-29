// Shared helpers for the LLM-driven surfaces (synopsis,
// recommendations, call brief, /ask). Extracted during the
// post-buildout audit to reduce drift across the four surfaces —
// per audit doc §3.6.

// ---------------------------------------------------------------------------
// Shared prompt preamble
//
// Every LLM-driven surface in this app operates as a "narrator over
// structured input": the prompt provides typed data, the LLM writes
// language over it. These rules apply universally — every surface
// should include this preamble in its system prompt before its
// surface-specific instructions.
//
// Per project_llm_input_extensibility memory.

export const LLM_CORE_RULES = `Core rules (apply to every output):
- Cite ONLY facts present in the input. NEVER invent names, numbers,
  dates, or attributes.
- When citing a metric, include the specific value or comparison from
  the input ("down 32% vs prior period," not "declining noticeably").
- Be terse and direct. Peer-to-peer voice, no greetings or signoffs.
- If a future-input field (e.g. \`predictions\`, \`forecasts\`, \`call_intelligence\`)
  is present and non-empty, weight it appropriately. If empty, ignore it.`;

// ---------------------------------------------------------------------------
// Defensive JSON parsing
//
// Anthropic models occasionally wrap JSON output in markdown fences
// (```json ... ```) even when explicitly instructed not to. They may
// also include preamble or trailing text. This helper:
//   1. Strips markdown fences if present
//   2. Extracts the substring from the first `{` to the last `}` (or
//      first `[` to last `]` for arrays)
//   3. JSON.parse with try/catch
//   4. Hands the parsed unknown to the caller's validator
//   5. Returns null on any failure (caller surfaces "bad_output")

export function parseLlmJson<T>(
  raw: string,
  validator: (parsed: unknown) => T | null,
): T | null {
  if (typeof raw !== "string") return null;

  // Strip markdown code fences if the model wrapped its output despite
  // instructions. ```json ... ``` and ``` ... ``` both supported.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced ? fenced[1]! : raw;

  // Find the JSON object/array substring. Try object first, then
  // array, since most surfaces output objects.
  let start = candidate.indexOf("{");
  let end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    start = candidate.indexOf("[");
    end = candidate.lastIndexOf("]");
  }
  if (start < 0 || end <= start) return null;

  const json = candidate.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  return validator(parsed);
}
