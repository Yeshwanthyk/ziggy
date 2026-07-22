interface SemVer {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: ReadonlyArray<string>;
}

type ComparatorOperator = "=" | ">" | ">=" | "<" | "<=";

interface Comparator {
  readonly operator: ComparatorOperator;
  readonly version: SemVer;
}

type SemVerRange = ReadonlyArray<ReadonlyArray<Comparator>>;

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const comparatorPattern = /^(<=|>=|=|<|>)?(.*)$/;

/** Returns whether a canonical Ziggy range accepts the canonical running Ziggy version. */
export function isZiggyVersionCompatible(range: string, runningVersion: string): boolean {
  const parsedRange = parseSemVerRange(range);
  const parsedRunningVersion = parseSemVer(runningVersion);
  if (parsedRange === undefined || parsedRunningVersion === undefined) return false;
  return parsedRange.some((clause) => satisfiesClause(clause, parsedRunningVersion));
}

export function isCanonicalSemVer(version: string): boolean {
  return parseSemVer(version) !== undefined;
}

export function isCanonicalSemVerRange(range: string): boolean {
  return parseSemVerRange(range) !== undefined;
}

function parseSemVer(version: string): SemVer | undefined {
  const match = versionPattern.exec(version);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  const prerelease = match?.[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && hasLeadingZero(identifier))) {
    return undefined;
  }
  return { major, minor, patch, prerelease };
}

function parseSemVerRange(range: string): SemVerRange | undefined {
  if (range.length === 0 || range.trim() !== range || /[\t\r\n]/.test(range)) return undefined;
  const clauseTexts = range.split(" || ");
  if (clauseTexts.some((clause) => clause.length === 0)) return undefined;
  const clauses: Comparator[][] = [];
  for (const clauseText of clauseTexts) {
    const comparatorTexts = clauseText.split(" ");
    if (comparatorTexts.some((comparator) => comparator.length === 0)) return undefined;
    const clause: Comparator[] = [];
    for (const comparatorText of comparatorTexts) {
      const comparator = parseComparator(comparatorText);
      if (comparator === undefined) return undefined;
      clause.push(comparator);
    }
    clauses.push(clause);
  }
  return clauses;
}

function parseComparator(text: string): Comparator | undefined {
  const match = comparatorPattern.exec(text);
  const versionText = match?.[2];
  if (versionText === undefined) return undefined;
  const version = parseSemVer(versionText);
  if (version === undefined) return undefined;
  const operator = parseComparatorOperator(match?.[1]);
  if (operator === undefined) return undefined;
  return { operator, version };
}

function parseComparatorOperator(operator: string | undefined): ComparatorOperator | undefined {
  if (operator === undefined || operator === "=") return "=";
  if (operator === ">" || operator === ">=" || operator === "<" || operator === "<=") {
    return operator;
  }
  return undefined;
}

function satisfiesClause(clause: ReadonlyArray<Comparator>, runningVersion: SemVer): boolean {
  if (
    runningVersion.prerelease.length > 0 &&
    !clause.some(
      (comparator) =>
        comparator.version.prerelease.length > 0 && sameCore(comparator.version, runningVersion),
    )
  ) {
    return false;
  }
  return clause.every((comparator) => satisfiesComparator(comparator, runningVersion));
}

function satisfiesComparator(comparator: Comparator, runningVersion: SemVer): boolean {
  const precedence = compareSemVer(runningVersion, comparator.version);
  switch (comparator.operator) {
    case "=":
      return precedence === 0;
    case ">":
      return precedence > 0;
    case ">=":
      return precedence >= 0;
    case "<":
      return precedence < 0;
    case "<=":
      return precedence <= 0;
  }
}

function compareSemVer(left: SemVer, right: SemVer): number {
  const core =
    compareNumericIdentifier(left.major, right.major) ||
    compareNumericIdentifier(left.minor, right.minor) ||
    compareNumericIdentifier(left.patch, right.patch);
  if (core !== 0) return core;
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return compareNumericIdentifier(left, right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCore(left: SemVer, right: SemVer): boolean {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

function hasLeadingZero(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith("0");
}
