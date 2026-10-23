/**
 * Python behaviours that Home Assistant has and JavaScript lacks: `str.strip()`, the template marker test, and the
 * reading of a whole `data` string as a mapping. See docs/adr/0016-safety-policy.md, D3 and D6.
 */

/** The characters Python's `str.strip()` removes (JavaScript's `trim()` leaves some of them). */
const STRIP_CHARS = new Set<string>([
  " ",
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  "\x1c",
  "\x1d",
  "\x1e",
  "\x1f",
  "\x85",
  "\xa0",
  "\u1680",
  ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
]);

/** Python's `str.strip()`, with the set written out. */
export function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && STRIP_CHARS.has(text[start]!)) start += 1;
  while (end > start && STRIP_CHARS.has(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

/** Home Assistant's `is_template_string`: the text contains `{{`, `{%` or `{#`. */
export function isTemplate(text: string): boolean {
  return text.includes("{{") || text.includes("{%") || text.includes("{#");
}

/** Home Assistant's entity id pattern. */
const ENTITY_ID = /^(?!.+__)(?!_)[\da-z_]+(?<!_)\.(?!_)[\da-z_]+(?<!_)$/;

export function isEntityId(text: string): boolean {
  return ENTITY_ID.test(text);
}

/** A value read from a whole data string. Dictionaries have no prototype. */
export type PyValue = string | number | boolean | null | PyValue[] | { [key: string]: PyValue };

export type PyResult = { ok: true; value: Record<string, PyValue> } | { ok: false; reason: string };

class Fail extends Error {}

/** The whitespace the parser skips (Python skips more; a string that starts or ends with the rest is refused). */
const SKIP = new Set([" ", "\t", "\n", "\r", "\f"]);

/**
 * Reads a whole `data` or `data_template` string the way Home Assistant's `literal_eval` would, for the subset the
 * policy accepts: a dictionary whose values are dictionaries, sets, lists, tuples, strings (escapes `\\ \' \" \n \t`
 * only), whole and decimal numbers, True, False and None. No operators, names, comments, prefixes, joined strings or
 * negative numbers. A dictionary with the same key twice, at any depth, is refused. Anything else is not read, and
 * the caller refuses the request.
 */
export function parseWholeDataString(text: string): PyResult {
  let pos = 0;

  const skip = (): void => {
    while (pos < text.length && SKIP.has(text[pos]!)) pos += 1;
  };

  skip();
  if (text[pos] === "#" || text[pos] === "\\") {
    return { ok: false, reason: "it starts with a comment or a line continuation" };
  }

  const parseString = (): string => {
    const quote = text[pos]!;
    pos += 1;
    let out = "";
    for (;;) {
      if (pos >= text.length) throw new Fail("unterminated string");
      const c = text[pos]!;
      if (c === quote) {
        pos += 1;
        return out;
      }
      if (c === "\n" || c === "\r") throw new Fail("line break inside a string");
      if (c === "\\") {
        const next = text[pos + 1];
        const map: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', n: "\n", t: "\t" };
        if (next === undefined || !(next in map)) throw new Fail("unsupported escape");
        out += map[next]!;
        pos += 2;
        continue;
      }
      out += c;
      pos += 1;
    }
  };

  const parseNumber = (): number => {
    const match = /^\d+(?:\.\d+)?/.exec(text.slice(pos));
    if (!match) throw new Fail("bad number");
    pos += match[0].length;
    // A following name character would make this a different token (1_000, 1e5, 0x1f).
    if (pos < text.length && /[\w.]/.test(text[pos]!)) throw new Fail("unsupported number");
    return Number(match[0]);
  };

  /** A canonical text for a key, so that 1, 1.0 and True collide as they do in Python. */
  const canon = (value: PyValue, isTuple: boolean): string => {
    if (typeof value === "string") return `s:${value}`;
    if (typeof value === "number") return `n:${value}`;
    if (typeof value === "boolean") return `n:${value ? 1 : 0}`;
    if (value === null) return "none";
    if (Array.isArray(value) && isTuple) return `t:[${value.map((v) => canon(v, true)).join(",")}]`;
    throw new Fail("unhashable key");
  };

  type Parsed = { value: PyValue; tuple: boolean };

  const parseValue = (): Parsed => {
    skip();
    const c = text[pos];
    if (c === undefined) throw new Fail("unexpected end");
    if (c === "'" || c === '"') {
      const value = parseString();
      return { value, tuple: false };
    }
    if (/\d/.test(c)) return { value: parseNumber(), tuple: false };
    if (c === "{") return parseBraces();
    if (c === "[") {
      pos += 1;
      const items = parseItems("]");
      return { value: items.map((i) => i.value), tuple: false };
    }
    if (c === "(") {
      pos += 1;
      const start = pos;
      const items = parseItems(")");
      // (x) is x, (x,) and () are tuples.
      const body = text.slice(start, pos - 1);
      if (items.length === 1 && !/,\s*$/.test(body.trimEnd())) return items[0]!;
      return { value: items.map((i) => i.value), tuple: true };
    }
    for (const [word, value] of [
      ["True", true],
      ["False", false],
      ["None", null],
    ] as const) {
      if (text.startsWith(word, pos) && !/[\w]/.test(text[pos + word.length] ?? "")) {
        pos += word.length;
        return { value, tuple: false };
      }
    }
    throw new Fail("unsupported syntax");
  };

  /** Items up to the closing bracket, trailing comma allowed. */
  const parseItems = (close: string): Parsed[] => {
    const items: Parsed[] = [];
    for (;;) {
      skip();
      if (text[pos] === close) {
        pos += 1;
        return items;
      }
      items.push(parseValue());
      skip();
      if (text[pos] === ",") {
        pos += 1;
        continue;
      }
      if (text[pos] === close) {
        pos += 1;
        return items;
      }
      throw new Fail("expected , or a closing bracket");
    }
  };

  const parseBraces = (): Parsed => {
    pos += 1; // {
    skip();
    if (text[pos] === "}") {
      pos += 1;
      return { value: Object.create(null) as { [key: string]: PyValue }, tuple: false };
    }
    const first = parseValue();
    skip();
    if (text[pos] === ":") {
      const dict = Object.create(null) as { [key: string]: PyValue };
      const seen = new Set<string>();
      let key = first;
      for (;;) {
        const id = canon(key.value, key.tuple);
        if (seen.has(id)) throw new Fail("duplicate key");
        seen.add(id);
        pos += 1; // :
        const value = parseValue();
        dict[typeof key.value === "string" ? key.value : JSON.stringify(key.value)] = value.value;
        skip();
        if (text[pos] === ",") {
          pos += 1;
          skip();
          if (text[pos] === "}") {
            pos += 1;
            return { value: dict, tuple: false };
          }
          key = parseValue();
          skip();
          if (text[pos] !== ":") throw new Fail("expected :");
          continue;
        }
        if (text[pos] === "}") {
          pos += 1;
          return { value: dict, tuple: false };
        }
        throw new Fail("expected , or }");
      }
    }
    // A set.
    const items: Parsed[] = [first];
    for (;;) {
      if (text[pos] === ",") {
        pos += 1;
        skip();
        if (text[pos] === "}") {
          pos += 1;
          break;
        }
        items.push(parseValue());
        skip();
        continue;
      }
      if (text[pos] === "}") {
        pos += 1;
        break;
      }
      throw new Fail("expected , or }");
    }
    for (const item of items) canon(item.value, item.tuple); // an unhashable member is an error in Python
    return { value: items.map((i) => i.value), tuple: false };
  };

  try {
    skip();
    if (text[pos] !== "{") return { ok: false, reason: "it does not become a mapping" };
    const parsed = parseBraces();
    skip();
    if (pos !== text.length) return { ok: false, reason: "it holds more than one expression" };
    if (!isDict(parsed.value)) return { ok: false, reason: "it does not become a mapping" };
    return { ok: true, value: parsed.value };
  } catch (error) {
    if (error instanceof Fail) return { ok: false, reason: error.message };
    throw error;
  }
}

function isDict(value: PyValue): value is Record<string, PyValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
