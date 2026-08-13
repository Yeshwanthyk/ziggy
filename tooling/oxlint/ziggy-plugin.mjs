import noChainedTypeAssertions from "./ziggy/rules/no-chained-type-assertions.mjs";
import noConditionalEmptyObjectSpread from "./ziggy/rules/no-conditional-empty-object-spread.mjs";
import noKnownValueWidening from "./ziggy/rules/no-known-value-widening.mjs";
import noModuleMocking from "./ziggy/rules/no-module-mocking.mjs";
import noObjectParameters from "./ziggy/rules/no-object-parameters.mjs";
import noReflectApply from "./ziggy/rules/no-reflect-apply.mjs";
import noReflectGet from "./ziggy/rules/no-reflect-get.mjs";
import noRuntimeTypeof from "./ziggy/rules/no-runtime-typeof.mjs";
import noShapeInSymbolNames from "./ziggy/rules/no-shape-in-symbol-names.mjs";
import noUnknownParameters from "./ziggy/rules/no-unknown-parameters.mjs";
import noUnknownReturns from "./ziggy/rules/no-unknown-returns.mjs";
import noUnknownTypeAliases from "./ziggy/rules/no-unknown-type-aliases.mjs";
import noUnsafeDictionaryType from "./ziggy/rules/no-unsafe-dictionary-type.mjs";
import noUnsafeTypescriptSyntax from "./ziggy/rules/no-unsafe-typescript-syntax.mjs";
import noWidenThenAssert from "./ziggy/rules/no-widen-then-assert.mjs";
import requireSafetyCommentForTypeAssertion from "./ziggy/rules/require-safety-comment-for-type-assertion.mjs";

export default {
  meta: { name: "ziggy" },
  rules: {
    "no-chained-type-assertions": noChainedTypeAssertions,
    "no-conditional-empty-object-spread": noConditionalEmptyObjectSpread,
    "no-known-value-widening": noKnownValueWidening,
    "no-module-mocking": noModuleMocking,
    "no-object-parameters": noObjectParameters,
    "no-reflect-apply": noReflectApply,
    "no-reflect-get": noReflectGet,
    "no-runtime-typeof": noRuntimeTypeof,
    "no-shape-in-symbol-names": noShapeInSymbolNames,
    "no-unknown-parameters": noUnknownParameters,
    "no-unknown-returns": noUnknownReturns,
    "no-unknown-type-aliases": noUnknownTypeAliases,
    "no-unsafe-dictionary-type": noUnsafeDictionaryType,
    "no-unsafe-typescript-syntax": noUnsafeTypescriptSyntax,
    "no-widen-then-assert": noWidenThenAssert,
    "require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertion,
  },
};
