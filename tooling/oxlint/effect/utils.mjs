import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function toRepoRelative(filename) {
  return path.relative(repoRoot, path.resolve(filename)).split(path.sep).join("/");
}

export function isTestLike(filename) {
  const normalized = toRepoRelative(filename);
  return (
    /(\.|\/)(test|spec|e2e|node\.test)\.tsx?$/.test(normalized) ||
    normalized === "test" ||
    normalized.startsWith("test/") ||
    normalized.startsWith("tests/")
  );
}

export function isDeclarationFile(filename) {
  return toRepoRelative(filename).endsWith(".d.ts");
}

export function isAdapterFile(filename) {
  const normalized = toRepoRelative(filename);
  return normalized.startsWith("src/adapters/") || normalized.startsWith("test/adapters/");
}

export function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

export function getPropertyName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateIdentifier") return node.name;
  if (node.type === "Literal" && node.value === String(node.value)) return node.value;
  if (node.type === "StringLiteral") return node.value;
  return undefined;
}

export function getCallName(node) {
  const expression = unwrapExpression(node);
  if (expression?.type === "Identifier") return expression.name;
  if (expression?.type === "MemberExpression") return getPropertyName(expression.property);
  return undefined;
}

export function isIdentifier(node, name) {
  return node?.type === "Identifier" && (name === undefined || node.name === name);
}

export function isStringLiteral(node) {
  return (
    (node?.type === "Literal" && node.value === String(node.value)) ||
    node?.type === "StringLiteral"
  );
}

function typeName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "TSQualifiedName") {
    const left = typeName(node.left);
    const right = typeName(node.right);
    return left && right ? `${left}.${right}` : undefined;
  }
  return undefined;
}

export function typeReferenceName(node) {
  return node?.type === "TSTypeReference" ? typeName(node.typeName) : undefined;
}

function isPromiseType(node) {
  return typeReferenceName(node) === "Promise";
}

export function containsPromiseType(node) {
  if (!(node instanceof Object)) return false;
  if (!("type" in node)) return false;
  if (isPromiseType(node)) return true;

  switch (node.type) {
    case "TSTypeAnnotation":
      return containsPromiseType(node.typeAnnotation);
    case "TSFunctionType":
      return containsPromiseType(node.returnType);
    case "TSParenthesizedType":
      return containsPromiseType(node.typeAnnotation);
    case "TSUnionType":
    case "TSIntersectionType":
      return (node.types ?? []).some(containsPromiseType);
    case "TSConditionalType":
      return containsPromiseType(node.trueType) || containsPromiseType(node.falseType);
    default:
      return false;
  }
}

export function nodeName(node) {
  if (isIdentifier(node)) return node.name;
  if (node?.type === "PrivateIdentifier") return node.name;
  if (isStringLiteral(node)) return node.value;
  return undefined;
}
