import { describe, expect, it } from "vitest";
import { isEntityId, isTemplate, parseWholeDataString, pyStrip } from "../../src/policy/python";

describe("pyStrip", () => {
  const stripped = [
    " ", "\t", "\n", "\v", "\f", "\r", "\x1c", "\x1d", "\x1e", "\x1f", "\x85", "\xa0", "\u1680",
    "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a",
    "\u2028", "\u2029", "\u202f", "\u205f", "\u3000",
  ];

  it("removes exactly the characters of Python's str.strip(), at both ends", () => {
    for (const ch of stripped) {
      expect(pyStrip(`${ch}light.a${ch}`), JSON.stringify(ch)).toBe("light.a");
    }
  });

  it("leaves characters that JavaScript or other tools treat as space but Python does not", () => {
    for (const ch of ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\x00", "\x1b", "\u180e"]) {
      expect(pyStrip(`${ch}x${ch}`), JSON.stringify(ch)).toBe(`${ch}x${ch}`);
    }
  });

  it("removes characters that JavaScript's trim() leaves", () => {
    for (const ch of ["\x1c", "\x1d", "\x1e", "\x1f", "\x85"]) {
      expect(`${ch}x`.trim()).not.toBe("x");
      expect(pyStrip(`${ch}x`)).toBe("x");
    }
  });

  it("keeps inner characters", () => {
    expect(pyStrip("  a b c  ")).toBe("a b c");
  });
});

describe("templates and entity ids", () => {
  it("recognises the three template markers", () => {
    expect(isTemplate("{{ x }}")).toBe(true);
    expect(isTemplate("a {% if x %}b{% endif %}")).toBe(true);
    expect(isTemplate("{# note #}")).toBe(true);
    expect(isTemplate("{ x }")).toBe(false);
    expect(isTemplate("[Door] open")).toBe(false);
  });

  it("matches Home Assistant's entity id pattern", () => {
    expect(isEntityId("light.kitchen_2")).toBe(true);
    expect(isEntityId("light.kitchen__2")).toBe(false);
    expect(isEntityId("_light.kitchen")).toBe(false);
    expect(isEntityId("light.kitchen_")).toBe(false);
    expect(isEntityId("Light.kitchen")).toBe(false);
    expect(isEntityId("light")).toBe(false);
    expect(isEntityId("light.a.b")).toBe(false);
  });
});

describe("parseWholeDataString", () => {
  const read = (text: string) => parseWholeDataString(text);

  it("reads the accepted constructs", () => {
    const r = read(
      "{'entity_id': ['light.a', \"light.b\"], 'n': 1, 'f': 2.5, 't': True, 'x': None, 'u': (1, 2,), 's': {'a', 'b',}, 'd': {'k': 'v\\n\\t\\\\\\'\\\"'},}",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.entity_id).toEqual(["light.a", "light.b"]);
      expect(r.value.n).toBe(1);
      expect(r.value.f).toBe(2.5);
      expect(r.value.t).toBe(true);
      expect(r.value.x).toBeNull();
      expect(r.value.u).toEqual([1, 2]);
      expect(r.value.s).toEqual(["a", "b"]);
      expect((r.value.d as Record<string, unknown>).k).toBe("v\n\t\\'\"");
    }
  });

  it("skips the five whitespace characters the parser knows, before and after", () => {
    for (const ch of [" ", "\t", "\n", "\r", "\f"]) {
      const r = read(`${ch}{'a': 1}${ch}`);
      expect(r.ok, JSON.stringify(ch)).toBe(true);
    }
  });

  it("refuses a leading or trailing character that only Python strips", () => {
    for (const ch of ["\v", "\x1c", "\x1f", "\x85", "\xa0", " ", "　"]) {
      expect(read(`${ch}{'a': 1}`).ok, `leading ${JSON.stringify(ch)}`).toBe(false);
      expect(read(`{'a': 1}${ch}`).ok, `trailing ${JSON.stringify(ch)}`).toBe(false);
    }
  });

  it("refuses a comment or a continuation first, however it is mixed with whitespace", () => {
    expect(read("# x\n{'a': 1}").ok).toBe(false);
    expect(read(" # x\n{'a': 1}").ok).toBe(false);
    expect(read("\\\n{'a': 1}").ok).toBe(false);
    expect(read("\n\t \\\n# y\n{'a': 1}").ok).toBe(false);
  });

  it("refuses everything that is not a mapping or outside the accepted syntax", () => {
    for (const text of [
      "text",
      "['a']",
      "{'a'}",
      "{}x",
      "{'a': 1} {'b': 2}",
      "{'a': -1}",
      "{'a': 1e5}",
      "{'a': 1_000}",
      "{'a': 0x1f}",
      "{'a': r'x'}",
      "{'a': b'x'}",
      "{'a': 'x' 'y'}",
      "{'a': '''x'''}",
      "{'a': 'x' + 'y'}",
      "{'a': name}",
      "{'a': 'bad \\x41'}",
      "{'a': 'line\nbreak'}",
      "{'a': 1  # comment\n}",
      "{'a': [1, 2}",
      "{'a': 'open}",
      "{[1]: 2}",
      "{{'a': 1}: 2}",
      "{'a': 1,, }",
    ]) {
      expect(read(text).ok, text).toBe(false);
    }
  });

  it("refuses a duplicate key at the top level and in a nested mapping", () => {
    expect(read("{'entity_id': 'light.a', 'entity_id': 'switch.shell'}").ok).toBe(false);
    expect(read("{'a': {'b': 1, 'b': 2}}").ok).toBe(false);
    expect(read("{1: 'a', 1.0: 'b'}").ok).toBe(false);
    expect(read("{1: 'a', True: 'b'}").ok).toBe(false);
    expect(read("{'a': {'b': 1}, 'c': {'b': 1}}").ok).toBe(true);
  });

  it("does not parse a string inside the result again", () => {
    const r = read("{'message': \"{'entity_id': 'switch.shell'}\"}");
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.value.message).toBe("string");
  });
});
