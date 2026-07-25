import { isAdapterFile, nodeName } from "../utils.mjs";

const errorConstructors = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const message =
  "Do not construct built-in Error objects in Effect domain code. Use typed domain errors and Effect.fail instead; at true adapter boundaries use a narrow suppression with a boundary reason. Skill: effect-typed-errors.";

const isErrorConstructor = (node) => errorConstructors.has(nodeName(node));

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow built-in Error constructors.",
    },
  },
  create(context) {
    if (isAdapterFile(context.filename)) return {};

    return {
      NewExpression(node) {
        if (isErrorConstructor(node.callee)) {
          context.report({ node, message });
        }
      },
      CallExpression(node) {
        if (isErrorConstructor(node.callee)) {
          context.report({ node, message });
        }
      },
    };
  },
};
