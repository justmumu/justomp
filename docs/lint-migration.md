# ESLint to Biome rule inventory

This is the reviewed migration snapshot for Justomp's managed JavaScript/TypeScript lint policy, checked against Biome 2.6.3 rule names and options. The runtime selects current stable latest when a new project joins; it does not expand presets automatically. See [lint configuration and migration](lint.md) for lifecycle, custom-policy handling and native limitations.

The table covers 225 previous entries, including disabled overrides: 150 named counterparts (125 active, 25 off), 41 partial mappings (36 active, 5 off), and 34 unavailable mappings (33 active, 1 off). A named counterpart does not guarantee identical semantics. Partial mappings use Biome's native behavior and the option differences below. Unavailable checks are omitted from the shipped baseline. The table describes migration intent, not a catalogue of rule-semantics tests.

Mapped active baseline checks use error severity, including explicitly selected nursery rules. Disabled overrides remain off. Base, TypeScript, React/Next and test maps retain their separate scopes. The complete executable default policy is in [lint-defaults.json](lint-defaults.json).

## rules

| Existing rule | Biome counterpart | Classification | Notes |
|---|---|---|---|
| `constructor-super` | `correctness.noInvalidConstructorSuper` | Counterpart |  |
| `for-direction` | `correctness.useValidForDirection` | Counterpart |  |
| `getter-return` | `suspicious.useGetterReturn` | Counterpart |  |
| `no-async-promise-executor` | `suspicious.noAsyncPromiseExecutor` | Counterpart |  |
| `no-case-declarations` | `correctness.noSwitchDeclarations` | Counterpart |  |
| `no-class-assign` | `suspicious.noClassAssign` | Counterpart |  |
| `no-compare-neg-zero` | `suspicious.noCompareNegZero` | Counterpart |  |
| `no-cond-assign` | `suspicious.noAssignInExpressions` | Partial | Inspired mapping; semantics/options can differ. |
| `no-const-assign` | `correctness.noConstAssign` | Counterpart |  |
| `no-constant-binary-expression` | `suspicious.noConstantBinaryExpressions` | Counterpart |  |
| `no-constant-condition` | `correctness.noConstantCondition` | Counterpart |  |
| `no-control-regex` | `suspicious.noControlCharactersInRegex` | Counterpart |  |
| `no-debugger` | `suspicious.noDebugger` | Counterpart |  |
| `no-delete-var` | `performance.noDelete` | Partial | Broader than only deletion of variables. |
| `no-dupe-args` | `suspicious.noDuplicateParameters` | Counterpart |  |
| `no-dupe-class-members` | `suspicious.noDuplicateClassMembers` | Counterpart |  |
| `no-dupe-else-if` | `suspicious.noDuplicateElseIf` | Counterpart |  |
| `no-dupe-keys` | `suspicious.noDuplicateObjectKeys` | Counterpart |  |
| `no-duplicate-case` | `suspicious.noDuplicateCase` | Counterpart |  |
| `no-empty` | `suspicious.noEmptyBlockStatements` | Counterpart |  |
| `no-empty-character-class` | `correctness.noEmptyCharacterClassInRegex` | Counterpart |  |
| `no-empty-pattern` | `correctness.noEmptyPattern` | Counterpart |  |
| `no-empty-static-block` | `suspicious.noEmptyBlockStatements` | Counterpart |  |
| `no-ex-assign` | `suspicious.noCatchAssign` | Counterpart |  |
| `no-extra-boolean-cast` | `complexity.noExtraBooleanCast` | Counterpart |  |
| `no-fallthrough` | `suspicious.noFallthroughSwitchClause` | Counterpart |  |
| `no-func-assign` | `suspicious.noFunctionAssign` | Counterpart |  |
| `no-global-assign` | `suspicious.noGlobalAssign` | Counterpart |  |
| `no-import-assign` | `suspicious.noImportAssign` | Counterpart |  |
| `no-invalid-regexp` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `no-irregular-whitespace` | `suspicious.noIrregularWhitespace` | Counterpart |  |
| `no-loss-of-precision` | `correctness.noPrecisionLoss` | Counterpart |  |
| `no-misleading-character-class` | `suspicious.noMisleadingCharacterClass` | Counterpart |  |
| `no-new-native-nonconstructor` | `correctness.noInvalidBuiltinInstantiation` | Counterpart |  |
| `no-nonoctal-decimal-escape` | `correctness.noNonoctalDecimalEscape` | Counterpart |  |
| `no-obj-calls` | `correctness.noGlobalObjectCalls` | Counterpart |  |
| `no-octal` | `nursery.noOctal` | Counterpart |  |
| `no-prototype-builtins` | `suspicious.noPrototypeBuiltins` | Counterpart |  |
| `no-redeclare` | `suspicious.noRedeclare` | Counterpart |  |
| `no-regex-spaces` | `complexity.noAdjacentSpacesInRegex` | Counterpart |  |
| `no-self-assign` | `correctness.noSelfAssign` | Counterpart |  |
| `no-setter-return` | `correctness.noSetterReturn` | Counterpart |  |
| `no-shadow-restricted-names` | `suspicious.noShadowRestrictedNames` | Counterpart |  |
| `no-sparse-arrays` | `suspicious.noSparseArray` | Counterpart |  |
| `no-this-before-super` | `correctness.noUnreachableSuper` | Counterpart |  |
| `no-undef` | `correctness.noUndeclaredVariables` | Counterpart |  |
| `no-unexpected-multiline` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `no-unreachable` | `correctness.noUnreachable` | Counterpart |  |
| `no-unsafe-finally` | `correctness.noUnsafeFinally` | Counterpart |  |
| `no-unsafe-negation` | `suspicious.noUnsafeNegation` | Counterpart |  |
| `no-unsafe-optional-chaining` | `correctness.noUnsafeOptionalChaining` | Counterpart |  |
| `no-unused-labels` | `correctness.noUnusedLabels` | Counterpart |  |
| `no-unused-private-class-members` | `correctness.noUnusedPrivateClassMembers` | Partial | Inspired mapping; semantics/options can differ. |
| `no-unused-vars` | `correctness.noUnusedVariables + correctness.noUnusedImports + correctness.noUnusedFunctionParameters` | Partial | Split checks: variables alone does not preserve imports/parameters coverage. |
| `no-useless-backreference` | `suspicious.noUselessRegexBackrefs` | Counterpart |  |
| `no-useless-catch` | `complexity.noUselessCatch` | Counterpart |  |
| `no-useless-escape` | `complexity.noUselessEscapeInRegex + suspicious.noUselessEscapeInString` | Partial | Split regex/string checks; verify remaining template cases. |
| `no-with` | `suspicious.noWith` | Counterpart |  |
| `require-yield` | `correctness.useYield` | Counterpart |  |
| `use-isnan` | `correctness.useIsNan` | Counterpart |  |
| `valid-typeof` | `correctness.useValidTypeof` | Counterpart |  |
| `eqeqeq` | `suspicious.noDoubleEquals` | Counterpart | Set ignoreNull:false to preserve always policy. |
| `curly` | `style.useBlockStatements` | Counterpart |  |
| `no-console` | `suspicious.noConsole` | Counterpart | allow:[warn,error] supported; test_rules overrides off. |
| `complexity` | `complexity.noExcessiveCognitiveComplexity` | Partial | Cognitive, not cyclomatic; maxAllowedComplexity 10 is a new metric, not equal severity. |
| `no-duplicate-imports` | `assist/source/organizeImports` | Partial | Merges imports and reexports as an assist, not identical duplicate-import diagnostics. |
| `simple-import-sort/imports` | `assist/source/organizeImports` | Partial | Different default ordering/groups; preserve bare import ordering by default. |
| `simple-import-sort/exports` | `assist/source/organizeImports` | Partial | Organizes exports too, different ordering semantics. |

## typed_rules

| Existing rule | Biome counterpart | Classification | Notes |
|---|---|---|---|
| `constructor-super` | `correctness.noInvalidConstructorSuper` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `getter-return` | `suspicious.useGetterReturn` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-class-assign` | `suspicious.noClassAssign` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-const-assign` | `correctness.noConstAssign` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-dupe-args` | `suspicious.noDuplicateParameters` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-dupe-class-members` | `suspicious.noDuplicateClassMembers` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-dupe-keys` | `suspicious.noDuplicateObjectKeys` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-func-assign` | `suspicious.noFunctionAssign` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-import-assign` | `suspicious.noImportAssign` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-new-native-nonconstructor` | `correctness.noInvalidBuiltinInstantiation` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-new-symbol` | `correctness.noInvalidBuiltinInstantiation` | Partial (off) | Legacy disabled entry; preserve intentional TS/test override where applicable. Inspired mapping; semantics/options can differ. |
| `no-obj-calls` | `correctness.noGlobalObjectCalls` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-redeclare` | `suspicious.noRedeclare` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-setter-return` | `correctness.noSetterReturn` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-this-before-super` | `correctness.noUnreachableSuper` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-undef` | `correctness.noUndeclaredVariables` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-unreachable` | `correctness.noUnreachable` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-unsafe-negation` | `suspicious.noUnsafeNegation` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `no-var` | `suspicious.noVar` | Counterpart |  |
| `no-with` | `suspicious.noWith` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `prefer-const` | `style.useConst` | Counterpart |  |
| `prefer-rest-params` | `complexity.noArguments` | Counterpart |  |
| `prefer-spread` | `style.useSpreadOverApply` | Counterpart |  |
| `@typescript-eslint/await-thenable` | `nursery.useAwaitThenable` | Partial | Independent type inference; not TS compiler semantics. |
| `@typescript-eslint/ban-ts-comment` | `suspicious.noTsIgnore` | Partial | Does not preserve minimumDescriptionLength=10 for @ts-expect-error etc. |
| `no-array-constructor` | `style.useArrayLiterals` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `@typescript-eslint/no-array-constructor` | `style.useArrayLiterals` | Counterpart |  |
| `@typescript-eslint/no-array-delete` | `performance.noDelete` | Partial | Broader: rejects delete use, not only array deletion. |
| `@typescript-eslint/no-base-to-string` | `nursery.noBaseToString` | Partial | Type/inference or option parity not guaranteed; explicit native rule supported. |
| `@typescript-eslint/no-confusing-void-expression` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-deprecated` | `suspicious.noDeprecatedImports` | Partial | Inspired mapping; semantics/options can differ. |
| `@typescript-eslint/no-duplicate-enum-values` | `suspicious.noDuplicateEnumValues` | Counterpart |  |
| `@typescript-eslint/no-duplicate-type-constituents` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-dynamic-delete` | `performance.noDelete` | Partial | Broader: rejects delete use, not only dynamic properties. |
| `@typescript-eslint/no-empty-object-type` | `complexity.noBannedTypes` | Partial | Inspired mapping; semantics/options can differ. |
| `@typescript-eslint/no-explicit-any` | `suspicious.noExplicitAny` | Counterpart |  |
| `@typescript-eslint/no-extra-non-null-assertion` | `suspicious.noExtraNonNullAssertion` | Counterpart |  |
| `@typescript-eslint/no-extraneous-class` | `complexity.noStaticOnlyClass` | Counterpart |  |
| `@typescript-eslint/no-floating-promises` | `nursery.noFloatingPromises` | Partial | Type/inference or option parity not guaranteed; explicit native rule supported. |
| `@typescript-eslint/no-for-in-array` | `suspicious.noForIn` | Partial | Inspired mapping; semantics/options can differ. |
| `no-implied-eval` | `nursery.noImpliedEval` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `@typescript-eslint/no-implied-eval` | `nursery.noImpliedEval` | Counterpart |  |
| `@typescript-eslint/no-invalid-void-type` | `suspicious.noConfusingVoidType` | Counterpart |  |
| `@typescript-eslint/no-meaningless-void-operator` | `nursery.noMeaninglessVoidOperator` | Counterpart |  |
| `@typescript-eslint/no-misused-new` | `suspicious.noMisleadingInstantiator` | Counterpart |  |
| `@typescript-eslint/no-misused-promises` | `nursery.noMisusedPromises` | Partial | Type/inference or option parity not guaranteed; explicit native rule supported. |
| `@typescript-eslint/no-misused-spread` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-mixed-enums` | `style.useConsistentEnumValueType` | Counterpart |  |
| `@typescript-eslint/no-namespace` | `style.noNamespace` | Counterpart |  |
| `@typescript-eslint/no-non-null-asserted-nullish-coalescing` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-non-null-asserted-optional-chain` | `suspicious.noNonNullAssertedOptionalChain` | Counterpart |  |
| `@typescript-eslint/no-non-null-assertion` | `style.noNonNullAssertion` | Counterpart |  |
| `@typescript-eslint/no-redundant-type-constituents` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-require-imports` | `style.noCommonJs` | Counterpart |  |
| `@typescript-eslint/no-this-alias` | `complexity.noUselessThisAlias` | Partial | Inspired mapping; semantics/options can differ. |
| `@typescript-eslint/no-unnecessary-boolean-literal-compare` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-unnecessary-condition` | `suspicious.noUnnecessaryConditions` | Partial | Inspired mapping; semantics/options can differ. |
| `@typescript-eslint/no-unnecessary-template-expression` | `complexity.noUnnecessaryTemplateExpression` | Partial | Inspired mapping; semantics/options can differ. |
| `@typescript-eslint/no-unnecessary-type-arguments` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-unnecessary-type-assertion` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-unnecessary-type-constraint` | `complexity.noUselessTypeConstraint` | Counterpart |  |
| `@typescript-eslint/no-unnecessary-type-conversion` | `nursery.noUselessTypeConversion` | Counterpart |  |
| `@typescript-eslint/no-unnecessary-type-parameters` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-unsafe-argument` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-unsafe-assignment` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-unsafe-call` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-unsafe-declaration-merging` | `suspicious.noUnsafeDeclarationMerging` | Counterpart |  |
| `@typescript-eslint/no-unsafe-enum-comparison` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-unsafe-function-type` | `complexity.noBannedTypes` | Partial | Inspired mapping; semantics/options can differ. |
| `@typescript-eslint/no-unsafe-member-access` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/no-unsafe-return` | `nursery.noUnsafeReturn` | Partial | Type/inference or option parity not guaranteed; explicit native rule supported. |
| `@typescript-eslint/no-unsafe-unary-minus` | `nursery.noUnsafeUnaryMinus` | Partial | Type/inference or option parity not guaranteed; explicit native rule supported. |
| `no-unused-expressions` | `suspicious.noUnusedExpressions` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `@typescript-eslint/no-unused-expressions` | `suspicious.noUnusedExpressions` | Partial | Core equivalent, not a verified TS-eslint option-equivalent. |
| `no-unused-vars` | `correctness.noUnusedVariables + correctness.noUnusedImports + correctness.noUnusedFunctionParameters` | Partial (off) | Legacy disabled entry; preserve intentional TS/test override where applicable. Split checks: variables alone does not preserve imports/parameters coverage. |
| `@typescript-eslint/no-unused-vars` | `correctness.noUnusedVariables + correctness.noUnusedImports + correctness.noUnusedFunctionParameters` | Partial | Split checks; underscore/argument conventions differ. |
| `no-useless-constructor` | `complexity.noUselessConstructor` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `@typescript-eslint/no-useless-constructor` | `complexity.noUselessConstructor` | Counterpart |  |
| `@typescript-eslint/no-wrapper-object-types` | `complexity.noBannedTypes` | Partial | Inspired mapping; semantics/options can differ. |
| `no-throw-literal` | `style.useThrowOnlyError` | Partial (off) | Legacy disabled entry; preserve intentional TS/test override where applicable. Inspired mapping; semantics/options can differ. |
| `@typescript-eslint/only-throw-error` | `style.useThrowOnlyError` | Partial | Inspired mapping; semantics/options can differ. |
| `@typescript-eslint/prefer-as-const` | `style.useAsConstAssertion` | Counterpart |  |
| `@typescript-eslint/prefer-literal-enum-member` | `style.useLiteralEnumMembers` | Counterpart |  |
| `@typescript-eslint/prefer-namespace-keyword` | `suspicious.useNamespaceKeyword` | Counterpart |  |
| `prefer-promise-reject-errors` | `nursery.usePromiseRejectErrors` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `@typescript-eslint/prefer-promise-reject-errors` | `nursery.usePromiseRejectErrors` | Partial | Type/inference or option parity not guaranteed; explicit native rule supported. |
| `@typescript-eslint/prefer-reduce-type-parameter` | `style.useReduceTypeParameter` | Partial | Inspired mapping; semantics/options can differ. |
| `@typescript-eslint/prefer-return-this-type` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/related-getter-setter-pairs` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `require-await` | `suspicious.useAwait` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable.  |
| `@typescript-eslint/require-await` | `suspicious.useAwait` | Partial | Type/inference or option parity not guaranteed; explicit native rule supported. |
| `@typescript-eslint/restrict-plus-operands` | `nursery.noUnsafePlusOperands` | Partial | No options in installed schema; five explicit legacy allow flags cannot be translated literally. |
| `@typescript-eslint/restrict-template-expressions` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `no-return-await` | `—` | Unavailable (off) | Legacy disabled entry; preserve intentional TS/test override where applicable. No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/return-await` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/triple-slash-reference` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/unbound-method` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/unified-signatures` | `style.useUnifiedTypeSignatures` | Counterpart |  |
| `@typescript-eslint/use-unknown-in-catch-callback-variable` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@typescript-eslint/consistent-type-imports` | `style.useImportType` | Partial | style:inlineType exists; semantics follow Biome rather than TS compiler. |

## test_rules

| Existing rule | Biome counterpart | Classification | Notes |
|---|---|---|---|
| `no-console` | `suspicious.noConsole` | Counterpart (off) | Legacy disabled entry; preserve intentional TS/test override where applicable. allow:[warn,error] supported; test_rules overrides off. |

## react_rules

| Existing rule | Biome counterpart | Classification | Notes |
|---|---|---|---|
| `react-hooks/rules-of-hooks` | `correctness.useHookAtTopLevel` | Counterpart |  |
| `react-hooks/exhaustive-deps` | `correctness.useExhaustiveDependencies` | Counterpart |  |
| `jsx-a11y/alt-text` | `a11y.useAltText` | Counterpart |  |
| `jsx-a11y/anchor-has-content` | `a11y.useAnchorContent` | Counterpart |  |
| `jsx-a11y/anchor-is-valid` | `a11y.useValidAnchor` | Counterpart |  |
| `jsx-a11y/aria-activedescendant-has-tabindex` | `a11y.useAriaActivedescendantWithTabindex` | Counterpart |  |
| `jsx-a11y/aria-props` | `a11y.useValidAriaProps` | Counterpart |  |
| `jsx-a11y/aria-proptypes` | `a11y.useValidAriaValues` | Counterpart |  |
| `jsx-a11y/aria-role` | `a11y.useValidAriaRole` | Counterpart |  |
| `jsx-a11y/aria-unsupported-elements` | `a11y.noAriaUnsupportedElements` | Counterpart |  |
| `jsx-a11y/autocomplete-valid` | `a11y.useValidAutocomplete` | Counterpart |  |
| `jsx-a11y/click-events-have-key-events` | `a11y.useKeyWithClickEvents` | Counterpart |  |
| `jsx-a11y/control-has-associated-label` | `nursery.useControlLabel` | Partial (off) | Legacy rule is disabled, including its options-bearing tuple; keep the mapped check disabled. |
| `jsx-a11y/heading-has-content` | `a11y.useHeadingContent` | Counterpart |  |
| `jsx-a11y/html-has-lang` | `a11y.useHtmlLang` | Counterpart |  |
| `jsx-a11y/iframe-has-title` | `a11y.useIframeTitle` | Counterpart |  |
| `jsx-a11y/img-redundant-alt` | `a11y.noRedundantAlt` | Counterpart |  |
| `jsx-a11y/interactive-supports-focus` | `a11y.useFocusableInteractive` | Partial | Installed schema has no tabbable option; cannot preserve custom role list. |
| `jsx-a11y/label-has-for` | `a11y.noLabelWithoutControl` | Partial (off) | Legacy disabled entry; preserve intentional TS/test override where applicable. Inspired mapping; semantics/options can differ. |
| `jsx-a11y/label-has-associated-control` | `a11y.noLabelWithoutControl` | Counterpart |  |
| `jsx-a11y/media-has-caption` | `a11y.useMediaCaption` | Counterpart |  |
| `jsx-a11y/mouse-events-have-key-events` | `a11y.useKeyWithMouseEvents` | Counterpart |  |
| `jsx-a11y/no-access-key` | `a11y.noAccessKey` | Counterpart |  |
| `jsx-a11y/no-autofocus` | `a11y.noAutofocus` | Counterpart |  |
| `jsx-a11y/no-distracting-elements` | `a11y.noDistractingElements` | Counterpart |  |
| `jsx-a11y/no-interactive-element-to-noninteractive-role` | `a11y.noInteractiveElementToNoninteractiveRole` | Counterpart |  |
| `jsx-a11y/no-noninteractive-element-interactions` | `a11y.noNoninteractiveElementInteractions` | Partial | Installed schema has no options; legacy body/iframe/img event exceptions cannot be translated literally. |
| `jsx-a11y/no-noninteractive-element-to-interactive-role` | `a11y.noNoninteractiveElementToInteractiveRole` | Counterpart |  |
| `jsx-a11y/no-noninteractive-tabindex` | `a11y.noNoninteractiveTabindex` | Counterpart |  |
| `jsx-a11y/no-redundant-roles` | `a11y.noRedundantRoles` | Counterpart |  |
| `jsx-a11y/no-static-element-interactions` | `a11y.noStaticElementInteractions` | Counterpart |  |
| `jsx-a11y/role-has-required-aria-props` | `a11y.useAriaPropsForRole` | Counterpart |  |
| `jsx-a11y/role-supports-aria-props` | `a11y.useAriaPropsSupportedByRole` | Counterpart |  |
| `jsx-a11y/scope` | `a11y.noHeaderScope` | Counterpart |  |
| `jsx-a11y/tabindex-no-positive` | `a11y.noPositiveTabindex` | Counterpart |  |

## next_rules

| Existing rule | Biome counterpart | Classification | Notes |
|---|---|---|---|
| `@next/next/google-font-display` | `suspicious.useGoogleFontDisplay` | Counterpart |  |
| `@next/next/google-font-preconnect` | `performance.useGoogleFontPreconnect` | Counterpart |  |
| `@next/next/next-script-for-ga` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@next/next/no-async-client-component` | `correctness.noNextAsyncClientComponent` | Counterpart |  |
| `@next/next/no-before-interactive-script-outside-document` | `correctness.noBeforeInteractiveScriptOutsideDocument` | Counterpart |  |
| `@next/next/no-css-tags` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@next/next/no-head-element` | `style.noHeadElement` | Counterpart |  |
| `@next/next/no-html-link-for-pages` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@next/next/no-img-element` | `performance.noImgElement` | Counterpart |  |
| `@next/next/no-page-custom-font` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@next/next/no-styled-jsx-in-document` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@next/next/no-sync-scripts` | `performance.noSyncScripts` | Counterpart |  |
| `@next/next/no-title-in-document-head` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@next/next/no-typos` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@next/next/no-unwanted-polyfillio` | `performance.noUnwantedPolyfillio` | Counterpart |  |
| `@next/next/inline-script-id` | `correctness.useInlineScriptId` | Counterpart |  |
| `@next/next/no-assign-module-variable` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@next/next/no-document-import-in-page` | `suspicious.noDocumentImportInPage` | Counterpart |  |
| `@next/next/no-duplicate-head` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |
| `@next/next/no-head-import-in-document` | `suspicious.noHeadImportInDocument` | Counterpart |  |
| `@next/next/no-script-component-in-head` | `—` | Unavailable | No verified native equivalent; do not invent compatibility. |


## Option differences

- `noDoubleEquals.options.ignoreNull=false`; `noConsole.options.allow=["warn","error"]`; `useImportType.options.style="inlineType"`.
- `noExcessiveCognitiveComplexity.options.maxAllowedComplexity=10` changes the complexity metric.
- `noTsIgnore` does not enforce the previous description-length requirement.
- `organizeImports` has its own import/export ordering; do not claim identical simple-import-sort output.
- Known shipped default differences use the explicit native baseline. Unsupported custom options produce a named migration error before config publication; see [migration behavior](lint.md#migrating-existing-javascript-policy).
