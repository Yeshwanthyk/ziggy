import noConditionalTests from "./effect/rules/no-conditional-tests.mjs";
import noEffectEscapeHatch from "./effect/rules/no-effect-escape-hatch.mjs";
import noEffectExecutionBoundary from "./effect/rules/no-effect-execution-boundary.mjs";
import noErrorConstructor from "./effect/rules/no-error-constructor.mjs";
import noInlineSchemaCompile from "./effect/rules/no-inline-schema-compile.mjs";
import noInstanceofError from "./effect/rules/no-instanceof-error.mjs";
import noInstanceofTaggedError from "./effect/rules/no-instanceof-tagged-error.mjs";
import noJsonParse from "./effect/rules/no-json-parse.mjs";
import noManualTagCheck from "./effect/rules/no-manual-tag-check.mjs";
import noMatchOrelse from "./effect/rules/no-match-orelse.mjs";
import noNativePromiseOwnership from "./effect/rules/no-native-promise-ownership.mjs";
import noPromiseCatch from "./effect/rules/no-promise-catch.mjs";
import noPromiseClientSurface from "./effect/rules/no-promise-client-surface.mjs";
import noRawFetch from "./effect/rules/no-raw-fetch.mjs";
import noRedundantErrorFactory from "./effect/rules/no-redundant-error-factory.mjs";
import noTryCatchOrThrow from "./effect/rules/no-try-catch-or-throw.mjs";
import noTsNocheck from "./effect/rules/no-ts-nocheck.mjs";
import noUnknownErrorMessage from "./effect/rules/no-unknown-error-message.mjs";
import noUnknownShapeProbing from "./effect/rules/no-unknown-shape-probing.mjs";
import noUnsupportedEffectApi from "./effect/rules/no-unsupported-effect-api.mjs";
import preferEffectPredicate from "./effect/rules/prefer-effect-predicate.mjs";
import preferSchemaInferredTypes from "./effect/rules/prefer-schema-inferred-types.mjs";
import preferValueInferredExtensionTypes from "./effect/rules/prefer-value-inferred-extension-types.mjs";
import preferYieldTaggedError from "./effect/rules/prefer-yield-tagged-error.mjs";

export default {
  meta: { name: "ziggy-effect" },
  rules: {
    "no-conditional-tests": noConditionalTests,
    "no-effect-escape-hatch": noEffectEscapeHatch,
    "no-effect-execution-boundary": noEffectExecutionBoundary,
    "no-error-constructor": noErrorConstructor,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-instanceof-error": noInstanceofError,
    "no-instanceof-tagged-error": noInstanceofTaggedError,
    "no-json-parse": noJsonParse,
    "no-manual-tag-check": noManualTagCheck,
    "no-match-orelse": noMatchOrelse,
    "no-native-promise-ownership": noNativePromiseOwnership,
    "no-promise-catch": noPromiseCatch,
    "no-promise-client-surface": noPromiseClientSurface,
    "no-raw-fetch": noRawFetch,
    "no-redundant-error-factory": noRedundantErrorFactory,
    "no-try-catch-or-throw": noTryCatchOrThrow,
    "no-ts-nocheck": noTsNocheck,
    "no-unknown-error-message": noUnknownErrorMessage,
    "no-unknown-shape-probing": noUnknownShapeProbing,
    "no-unsupported-effect-api": noUnsupportedEffectApi,
    "prefer-effect-predicate": preferEffectPredicate,
    "prefer-schema-inferred-types": preferSchemaInferredTypes,
    "prefer-value-inferred-extension-types": preferValueInferredExtensionTypes,
    "prefer-yield-tagged-error": preferYieldTaggedError,
  },
};
