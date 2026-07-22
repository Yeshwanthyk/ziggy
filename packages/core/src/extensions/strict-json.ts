interface ParsedString {
  readonly ok: true;
  readonly value: string;
}

interface InvalidString {
  readonly ok: false;
}

type StringResult = ParsedString | InvalidString;

/** Validates JSON syntax while rejecting duplicate decoded object keys at every depth. */
export function isStrictJson(text: string): boolean {
  const parser = new StrictJsonParser(text);
  return parser.parse();
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): boolean {
    this.skipWhitespace();
    if (!this.parseValue()) return false;
    this.skipWhitespace();
    return this.index === this.text.length;
  }

  private parseValue(): boolean {
    const character = this.text[this.index];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') return this.parseString().ok;
    if (character === "t") return this.consume("true");
    if (character === "f") return this.consume("false");
    if (character === "n") return this.consume("null");
    return this.parseNumber();
  }

  private parseObject(): boolean {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.consume("}")) return true;

    while (this.index < this.text.length) {
      const key = this.parseString();
      if (!key.ok || keys.has(key.value)) return false;
      keys.add(key.value);
      this.skipWhitespace();
      if (!this.consume(":")) return false;
      this.skipWhitespace();
      if (!this.parseValue()) return false;
      this.skipWhitespace();
      if (this.consume("}")) return true;
      if (!this.consume(",")) return false;
      this.skipWhitespace();
    }
    return false;
  }

  private parseArray(): boolean {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("]")) return true;

    while (this.index < this.text.length) {
      if (!this.parseValue()) return false;
      this.skipWhitespace();
      if (this.consume("]")) return true;
      if (!this.consume(",")) return false;
      this.skipWhitespace();
    }
    return false;
  }

  private parseString(): StringResult {
    if (!this.consume('"')) return { ok: false };
    let value = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === undefined) return { ok: false };
      this.index += 1;
      if (character === '"') return { ok: true, value };
      if (character === "\\") {
        const escaped = this.parseEscape();
        if (!escaped.ok) return escaped;
        value += escaped.value;
      } else {
        if (character.charCodeAt(0) <= 0x1f) return { ok: false };
        value += character;
      }
    }
    return { ok: false };
  }

  private parseEscape(): StringResult {
    const character = this.text[this.index];
    if (character === undefined) return { ok: false };
    this.index += 1;
    const escapes: Readonly<Record<string, string>> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    const escaped = escapes[character];
    if (escaped !== undefined) return { ok: true, value: escaped };
    if (character !== "u") return { ok: false };
    const digits = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) return { ok: false };
    this.index += 4;
    return { ok: true, value: String.fromCharCode(Number.parseInt(digits, 16)) };
  }

  private parseNumber(): boolean {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    const number = match?.[0];
    if (number === undefined) return false;
    this.index += number.length;
    return true;
  }

  private consume(expected: string): boolean {
    if (!this.text.startsWith(expected, this.index)) return false;
    this.index += expected.length;
    return true;
  }

  private skipWhitespace(): void {
    while (isJsonWhitespace(this.text[this.index])) {
      this.index += 1;
    }
  }
}

function isJsonWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}
