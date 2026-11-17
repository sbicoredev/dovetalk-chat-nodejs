/** `--name value` and `--flag` arguments, with the environment as a fallback (NAME in upper snake case). */
export function parseArgs(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument "${token}". Options start with --.`);
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(name, "true");
    } else {
      values.set(name, next);
      index += 1;
    }
  }
  return values;
}

export class Options {
  private readonly values: Map<string, string>;

  constructor(argv: readonly string[]) {
    this.values = parseArgs(argv);
  }

  private raw(name: string): string | undefined {
    return this.values.get(name) ?? process.env[name.toUpperCase().replaceAll("-", "_")];
  }

  string(name: string, fallback?: string): string {
    const value = this.raw(name) ?? fallback;
    if (value === undefined || value === "") {
      throw new Error(`Missing --${name} (or ${name.toUpperCase().replaceAll("-", "_")}).`);
    }
    return value;
  }

  optional(name: string): string | undefined {
    const value = this.raw(name);
    return value === undefined || value === "" ? undefined : value;
  }

  number(name: string, fallback: number): number {
    const value = this.raw(name);
    if (value === undefined || value === "") {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`--${name} must be a number, got "${value}".`);
    }
    return parsed;
  }

  flag(name: string): boolean {
    return this.raw(name) === "true";
  }

  list(name: string): string[] {
    return (this.raw(name) ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
}
