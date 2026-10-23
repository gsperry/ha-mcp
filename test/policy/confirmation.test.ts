import { describe, expect, it } from "vitest";
import {
  base64url,
  configDigest,
  displayAlias,
  displayEntity,
  displayId,
  drawCode,
  issueChallenge,
  normaliseCode,
  notificationMessage,
  parseChallenge,
  verifyChallenge,
} from "../../src/policy/confirmation";

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("drawCode", () => {
  it("writes eight digits with leading zeros, and reduces a value modulo 10^8", () => {
    expect(drawCode(() => 7)).toBe("00000007");
    expect(drawCode(() => 0)).toBe("00000000");
    expect(drawCode(() => 123_456_789)).toBe("23456789");
    expect(drawCode(() => 4_199_999_999)).toBe("99999999");
  });

  it("draws again for values at or above 4,200,000,000, so every code is equally likely", () => {
    const values = [4_200_000_000, 4_294_967_295, 4_200_000_001, 42];
    let calls = 0;
    const code = drawCode(() => values[calls++]!);
    expect(code).toBe("00000042");
    expect(calls).toBe(4);
  });

  it("with the real random source gives eight digits", () => {
    for (let i = 0; i < 50; i++) expect(drawCode()).toMatch(/^[0-9]{8}$/);
  });
});

describe("configDigest", () => {
  it("is 22 base64url characters, the same for any key order at any depth, and different for any value change", async () => {
    const a = { alias: "x", triggers: [{ trigger: "state", entity_id: "light.a", to: "on" }], nested: { p: 1, q: [1, 2, { z: 1, y: 2 }] } };
    const reordered = { nested: { q: [1, 2, { y: 2, z: 1 }], p: 1 }, triggers: [{ to: "on", entity_id: "light.a", trigger: "state" }], alias: "x" };
    const digest = await configDigest(a);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await configDigest(reordered)).toBe(digest);

    for (const changed of [
      { ...a, alias: "y" },
      { ...a, extra: null },
      { ...a, nested: { p: 2, q: [1, 2, { z: 1, y: 2 }] } },
      { ...a, nested: { p: 1, q: [2, 1, { z: 1, y: 2 }] } },
      { ...a, nested: { p: 1, q: [1, 2, { z: 1, y: 3 }] } },
      { ...a, nested: { p: "1", q: [1, 2, { z: 1, y: 2 }] } },
    ]) {
      expect(await configDigest(changed)).not.toBe(digest);
    }
  });

  it("keeps an own __proto__ key in the digest", async () => {
    const plain = JSON.parse('{"a":1}');
    const proto = JSON.parse('{"a":1,"__proto__":{"b":2}}');
    expect(await configDigest(proto)).not.toBe(await configDigest(plain));
  });
});

describe("the challenge and its tag", () => {
  const TOKEN = "test-ha-token";
  const ID = "ui_1";
  const EXPIRY = 1_800_000_000;
  const CODE = "12345678";

  async function derivedKey(token: string): Promise<CryptoKey> {
    const root = await crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const raw = await crypto.subtle.sign("HMAC", root, encoder.encode("ha-mcp delete confirmation v1"));
    return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }

  it("has four fields, and its tag is the HMAC under the key derived from HA_TOKEN over the array of purpose, id, expiry, digest and code", async () => {
    const digest = await configDigest({ alias: "x" });
    const challenge = await issueChallenge(TOKEN, ID, EXPIRY, digest, CODE);
    const [version, expiry, digestField, tag] = challenge.split(".");
    expect(version).toBe("dc1");
    expect(expiry).toBe(String(EXPIRY));
    expect(digestField).toBe(digest);
    const expected = await crypto.subtle.sign(
      "HMAC",
      await derivedKey(TOKEN),
      encoder.encode(JSON.stringify(["ha-mcp/delete-confirmation/v1", ID, String(EXPIRY), digest, CODE])),
    );
    expect(tag).toBe(base64url(new Uint8Array(expected)));
    expect(challenge.length).toBeLessThanOrEqual(83);
  });

  it("holds no unkeyed hash of the code, of the id and code, or of the fields", async () => {
    const digest = await configDigest({ alias: "x" });
    const challenge = await issueChallenge(TOKEN, ID, EXPIRY, digest, CODE);
    const inputs = [
      CODE,
      `${ID}${CODE}`,
      `${ID}:${CODE}`,
      `${CODE}${ID}`,
      `${ID}${EXPIRY}${digest}${CODE}`,
      `${ID}.${EXPIRY}.${digest}.${CODE}`,
      JSON.stringify(["ha-mcp/delete-confirmation/v1", ID, String(EXPIRY), digest, CODE]),
      `${TOKEN}${CODE}`,
    ];
    for (const algorithm of ["SHA-1", "SHA-256", "MD5"]) {
      for (const input of inputs) {
        const hash = await crypto.subtle.digest(algorithm, encoder.encode(input));
        const forms = [hex(hash), base64url(new Uint8Array(hash))];
        for (const form of forms) {
          for (const piece of [form, form.slice(0, 22), form.slice(0, 16)]) {
            expect(challenge, `${algorithm} of ${input}`).not.toContain(piece);
          }
        }
      }
    }
    expect(challenge).not.toContain(CODE);
  });

  async function verify(token: string, id: string, challenge: string, code: string): Promise<boolean> {
    const parsed = parseChallenge(challenge);
    if (!parsed.ok) throw new Error(parsed.reason);
    return verifyChallenge(token, id, parsed.value, code);
  }

  it("verifies only for the same key, id, expiry, digest and code", async () => {
    const digest = await configDigest({ alias: "x" });
    const challenge = await issueChallenge(TOKEN, ID, EXPIRY, digest, CODE);
    expect(await verify(TOKEN, ID, challenge, CODE)).toBe(true);
    expect(await verify("another-token", ID, challenge, CODE)).toBe(false);
    expect(await verify(TOKEN, "ui_2", challenge, CODE)).toBe(false);
    expect(await verify(TOKEN, ID, challenge, "12345679")).toBe(false);
    const fields = challenge.split(".");
    expect(await verify(TOKEN, ID, [fields[0], String(EXPIRY + 1), fields[2], fields[3]].join("."), CODE)).toBe(false);
    expect(await verify(TOKEN, ID, [fields[0], `0${fields[1]}`, fields[2], fields[3]].join("."), CODE)).toBe(false);
    const otherDigest = await configDigest({ alias: "y" });
    expect(await verify(TOKEN, ID, [fields[0], fields[1], otherDigest, fields[3]].join("."), CODE)).toBe(false);
  });

  it("refuses to sign with an empty token", async () => {
    await expect(issueChallenge("", ID, EXPIRY, await configDigest({}), CODE)).rejects.toThrow(/empty/);
  });

  describe("parsing", () => {
    const good = async () => issueChallenge(TOKEN, ID, EXPIRY, await configDigest({ a: 1 }), CODE);
    const edit = async (change: (fields: string[]) => string | string[]) => {
      const fields = (await good()).split(".");
      const out = change(fields);
      return Array.isArray(out) ? out.join(".") : out;
    };

    it("accepts a good challenge", async () => {
      expect(parseChallenge(await good()).ok).toBe(true);
    });

    it.each<[string, (f: string[]) => string | string[]]>([
      ["longer than 128 characters", (f) => `${f.join(".")}${"A".repeat(60)}`],
      ["three fields", (f) => [f[0]!, f[1]!, f[2]!]],
      ["five fields", (f) => [...f, "x"]],
      ["another version tag", (f) => ["dc2", f[1]!, f[2]!, f[3]!]],
      ["an expiry with a sign", (f) => [f[0]!, `+${f[1]}`, f[2]!, f[3]!]],
      ["an expiry with a space", (f) => [f[0]!, ` ${f[1]}`, f[2]!, f[3]!]],
      ["an expiry with a non-ASCII digit", (f) => [f[0]!, "١٨٠٠٠٠٠٠٠٠", f[2]!, f[3]!]],
      ["an expiry of 13 digits", (f) => [f[0]!, "1800000000000", f[2]!, f[3]!]],
      ["an empty expiry", (f) => [f[0]!, "", f[2]!, f[3]!]],
      ["a digest that is too short", (f) => [f[0]!, f[1]!, f[2]!.slice(1), f[3]!]],
      ["a digest that is too long", (f) => [f[0]!, f[1]!, `${f[2]!}A`, f[3]!]],
      ["a digest with the wrong alphabet", (f) => [f[0]!, f[1]!, `${f[2]!.slice(1)}+`, f[3]!]],
      ["a tag that is too short", (f) => [f[0]!, f[1]!, f[2]!, f[3]!.slice(1)]],
      ["a tag with the wrong alphabet", (f) => [f[0]!, f[1]!, f[2]!, `${f[3]!.slice(1)}=`]],
      [
        "a tag with spare bits set",
        (f) => {
          const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
          const last = alphabet.indexOf(f[3]!.slice(-1));
          return [f[0]!, f[1]!, f[2]!, f[3]!.slice(0, 42) + alphabet[last | 1]];
        },
      ],
      ["an empty text", () => ""],
    ])("refuses %s", async (_name, change) => {
      const parsed = parseChallenge(await edit(change));
      expect(parsed.ok, _name).toBe(false);
    });

    it("keeps the expiry and digest as the exact text given", async () => {
      const challenge = await good();
      const parsed = parseChallenge(challenge);
      expect(parsed.ok && parsed.value.expiryText).toBe(String(EXPIRY));
      expect(parsed.ok && parsed.value.digest).toBe(challenge.split(".")[2]);
    });
  });

  describe("normaliseCode", () => {
    it("accepts eight digits, with ASCII spaces and hyphens removed", () => {
      for (const text of ["12345678", "1234 5678", "1234-5678", " 1234 - 5678 ", "12 34 56 78"]) {
        expect(normaliseCode(text), text).toEqual({ ok: true, value: "12345678" });
      }
    });

    it("refuses a code over 32 characters, with a Unicode space, a non-ASCII digit or the wrong length", () => {
      for (const text of [
        `${"1".repeat(8)}${" ".repeat(25)}`,
        "1234\u00a05678",
        "1234\u20095678",
        "1234\u30005678",
        "\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18",
        "\u0663\u0663\u0663\u0663\u0663\u0663\u0663\u0663",
        "1234567",
        "123456789",
        "1234567a",
        "",
        "1234_5678",
        "1234\t5678",
      ]) {
        expect(normaliseCode(text).ok, JSON.stringify(text)).toBe(false);
      }
    });
  });
});

describe("the notification text", () => {
  const code = "12345678";
  const message = (alias: unknown, id = "a1", entity: unknown = "automation.porch_light") => notificationMessage(id, entity, alias, code);
  const quoted = (text: string): string => {
    const match = /named '([^']*)'\. Confirmation code/.exec(text);
    if (!match) throw new Error(`The alias is not one quoted piece: ${text}`);
    return match[1]!;
  };

  it("has the documented shape, with the code in two groups", () => {
    expect(message("Porch light")).toBe(
      "Claude asked to delete the automation with id a1, entity automation.porch_light, named 'Porch light'. " +
        "Confirmation code: 1234 5678. It expires in 5 minutes. If you did not ask for this, ignore this message and do not share the code.",
    );
  });

  const nasty: [string, string][] = [
    ["double quotes", 'say "hi" and "bye"'],
    ["single quotes", "it's 'quoted'"],
    ["typographic quotes", "\u201cleft\u201d \u2018single\u2019 \u00abguillemets\u00bb \u201egerman\u201f \u2039x\u203a"],
    ["a false id in parentheses", "x (id evil, entity automation.evil)"],
    ["a false id without parentheses", "x id evil, entity automation.evil"],
    ["a lone surrogate", "a\ud800b"],
    ["a lone low surrogate", "a\udc00b"],
    ["line breaks", "line one\nline two\r\nline three"],
    ["U+2028 and U+2029", "a\u2028b\u2029c"],
    ["a bidirectional override and isolates", "a\u202eb\u2066c\u2069d\u202ce\u200ff\u200ee"],
    ["other format characters", "a\u200bb\u2060c\ufeffd\u00ade"],
    ["control characters", "a\u0000b\u0007c\u001bd\u0085e\u007f"],
    ["a long alias", "x".repeat(200)],
    ["many spaces", "a      b \t\t c"],
  ];

  it.each(nasty)("an alias with %s yields one quoted plain alias of at most 60 code points", (_name, alias) => {
    const text = message(alias);
    const shown = quoted(text);
    expect(Array.from(shown).length).toBeLessThanOrEqual(63);
    expect(Array.from(shown.replace(/\.\.\.$/, "")).length).toBeLessThanOrEqual(60);
    expect(text).not.toMatch(/[\p{Cf}\p{Cc}\p{Cs}\u2028\u2029]/u);
    expect(shown).not.toMatch(/["'\u201c\u201d\u2018\u2019\u00ab\u00bb\u201e\u201f\u2039\u203a]/);
    expect(shown).not.toMatch(/\s{2,}/);
    expect(shown).toBe(shown.trim());
    // The real id and entity id come before the alias.
    expect(text.indexOf("id a1, entity automation.porch_light")).toBe(text.indexOf("with id") + "with ".length);
    expect(text.indexOf("id a1, entity automation.porch_light")).toBeLessThan(text.indexOf("named '"));
  });

  it("cuts a 200-character alias at 60 with three dots and keeps a 60-character one whole", () => {
    expect(quoted(message("x".repeat(200)))).toBe(`${"x".repeat(60)}...`);
    expect(quoted(message("y".repeat(60)))).toBe("y".repeat(60));
    // Counted as code points, not UTF-16 units.
    expect(quoted(message("\u{1F600}".repeat(61)))).toBe(`${"\u{1F600}".repeat(60)}...`);
  });

  it("turns quotes into backticks and false id text can only follow the real one", () => {
    const text = message("x' (id evil, entity automation.evil) \"");
    expect(quoted(text)).toBe("x` (id evil, entity automation.evil) `");
    expect(text.indexOf("id a1")).toBeLessThan(text.indexOf("id evil"));
  });

  it("shows (no alias) for a missing, empty, blank-after-cleaning or non-text alias", () => {
    for (const alias of [undefined, null, "", "   ", 5, { a: 1 }, ["x"], "\u202e\u200b", "''"]) {
      const expected = alias === "''" ? "``" : "(no alias)";
      expect(displayAlias(alias), JSON.stringify(alias)).toBe(expected);
    }
    expect(quoted(message(undefined))).toBe("(no alias)");
  });

  it("cleans an id the same way and cuts it at 64 code points", () => {
    expect(displayId("a'b\"c\u202ed\ne")).toBe("a`b`cd e");
    expect(displayId("x".repeat(100))).toBe("x".repeat(64));
    const text = message("fine", "evil' id\nnext");
    expect(text).toContain("with id evil` id next, entity");
  });

  it("copies an entity id only when it is a plain automation entity id", () => {
    expect(displayEntity("automation.porch_light")).toBe("entity automation.porch_light");
    for (const value of ["light.kitchen", "automation.Porch", "automation.a b", "automation.", "automation.a'b", "automation.x\n", null, undefined, 5, "", "automation.a.b"]) {
      expect(displayEntity(value), JSON.stringify(value)).toBe("entity unavailable");
    }
    expect(message("x", "a1", "automation.evil' injected")).toContain("id a1, entity unavailable, named");
  });
});
