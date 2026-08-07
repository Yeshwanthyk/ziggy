import { getPropertyName, unwrapExpression } from "../utils.mjs";

const escapeHatches = new Set(["die", "dieMessage", "ignore", "ignoreCause", "orDie", "orDieWith"]);

const message =
  "Do not erase Effect failures with die/orDie/ignore escape hatches. Keep typed errors in the error channel, or catch them explicitly and report, aggregate, or recover. Skill: effect-typed-errors.";

const isEffectEscapeHatch = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "MemberExpression") return false;
  const object = unwrapExpression(expression.object);
  if (object?.type !== "Identifier" || object.name !== "Effect") return false;
  const property = getPropertyName(expression.property);
  return escapeHatches.has(property);
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect failure-erasure escape hatches outside test code.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (isEffectEscapeHatch(node)) {
          context.report({ node, message });
        }
      },
    };
  },
};
