# 0008. Biome through Ultracite instead of ESLint and Prettier

- Status: accepted
- Date: 2026-11-14

## Context

At first the repo linted with ESLint (flat config, `typescript-eslint`, the Next and React
hooks plugins) and formatted with Prettier. That meant two tools, two configs, per-package `lint`
scripts that each started a type-aware ESLint run, and a dependency on `typescript-eslint` that
needed the programmatic TypeScript API (see ADR 0005). Everything was also slow enough to be felt in
the pre-commit hook.

## Decision

Use Biome, configured through the Ultracite presets, for linting, formatting and import ordering.

- One tool and one config: `biome.jsonc` at the root extends `ultracite/biome/{core,react,next,drizzle,vitest,type-aware}`.
- `pnpm lint` runs `biome check .` and fails on lint errors, formatting and import order, so CI has
  no separate format step. `pnpm format` runs `biome check --write .`. lint-staged runs
  `biome check --write` on staged files. The per-package `lint` scripts are removed.
- Biome and Ultracite are exact-pinned (`@biomejs/biome` 2.6.7, `ultracite` 8.2.0) and Renovate
  upgrades them together in one PR, because a new version can add or tighten rules.
- The old style is kept so the migration diff stayed small: 100 columns, trailing commas everywhere,
  and 100 columns for CSS, JSON and YAML (Ultracite defaults those to 80).
- Imports are organized by Biome: Node built-ins, packages, `@dovetalk/*`, the web app's `@/` alias,
  then relative paths, one blank line between groups. The `.vscode` settings apply this on save.
- `dependency-cruiser` stays. It checks module boundaries (`pnpm lint:boundaries`), which Biome
  does not do.

### Scoped opt-outs

Rules are switched off only where they clash with the idiom of the code, with the reason next to the
override in `biome.jsonc`:

- **Nest code** (`apps/api`, `apps/worker`, `packages/core`): `useImportType` (dependency injection
  needs value imports), `noParameterProperties`, `noEnum`, `noUselessConstructor`,
  `noStaticOnlyClass`, `useThisInClassMethods`, `noExcessiveClassesPerFile` and `useAwait`.
- **`waveform.ts`** (web and core copies of one 32-bit PRNG): `noBitwiseOperators`. A test pins the
  output, so the bit arithmetic is not rewritten.
- **Tests** (`*.test.*`, `test/`, the conformance suite, `packages/testkit`): `noNonNullAssertion`,
  `noAwaitInLoops`, `useTopLevelRegex`, `useNamedCaptureGroup`, `useExpect` and `noShadow`.
- **`apps/web`**: the prototype is still to be refactored, so the rules that ask for rewrites of working
  code are off (`noJsxPropsBind`, `noNestedTernary`, `noForEach`, `useIterableCallbackReturn`,
  `noAssignInExpressions`, `noReturnAssign`, `noUnnecessaryConditions`, `noArrayIndexKey`,
  `noLeakedRender`, `useDomQuerySelector`, `useDefaultSwitchClause`, `useErrorCause`, `useBaseline`,
  `useAwait`, `noEmptyBlockStatements`, `noConditionalExpect`). `useExhaustiveDependencies` and
  `noExcessiveCognitiveComplexity` are warnings, not errors.

A few findings are suppressed in place with a `biome-ignore` that gives the reason: `next/image`
cannot optimise blob, data and presigned URLs; one false positive in Biome's import resolver for
`Fragment` from `react`; the hook dependency arrays in `status-viewer.tsx` and `message-bubble.tsx`
that were already deliberate.

### Settings that must not change

- `useSortedPackageJson` is **off**. When on, it moves `"types"` ahead of the `"@dovetalk/source"`
  condition in the `exports` of `packages/{contracts,core,db}`. Conditions match in order, so
  TypeScript and Vitest would resolve `dist/*.d.ts` instead of the source, and tests would pass
  only while `dist` happened to be built.
- Never run `biome check --write --unsafe` across the repo. Two of its fixes are wrong here:
  `noNonNullAssertion` rewrites `x!` to `x?.`, which changes behaviour, and `noReactForwardRef`
  produced code with a missing import. Fixes that Biome marks safe are applied by plain `--write`.

## Consequences

- One command lints, formats and orders imports, and it is fast enough for the pre-commit hook.
- Biome does not format Markdown, so `.md` files are no longer auto-formatted. Prettier is removed
  entirely rather than kept for docs; keep Markdown tidy by hand.
- The web app carries 12 warnings (8 cognitive complexity, 4 hook dependencies) and a longer list of
  switched-off rules until the UI is refactored. Turn the rules back on as it is.
- `typescript-eslint` is gone, so the `typescript` alias recorded in ADR 0005 is now needed only by
  `dependency-cruiser` and `@nestjs/swagger`.
- Biome's rule set is younger and moves faster than ESLint's. Pinning and grouped upgrades keep
  that predictable.
- Rollback is `git revert` of the commit `chore: replace ESLint and Prettier with Biome`, which
  restores the old configs, scripts and dependencies. The code was reformatted by Biome earlier on
  the branch, so run Prettier over it once afterwards.
