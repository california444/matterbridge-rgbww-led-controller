# Claude Instructions

Matterbridge plugin (TypeScript, ESM) that exposes ESP RGBWW LED controllers as Matter extended color lights. Source in `src/`, Vitest tests in `vitest/`, project overview in [README.md](./README.md).

## Style And Formatting

- Follow [STYLEGUIDE.md](./STYLEGUIDE.md) for code style, naming, JSDoc, validation, logging and formatting.
- JSDoc requirements are enforced by the linter. Treat missing or incomplete JSDoc on required APIs as a real lint issue.
- Import and export ordering are enforced by the formatter. Preserve the grouped and sorted order and do not fight the formatter.
- For Matterbridge APIs follow [.claude/rules/matterbridge.md](./.claude/rules/matterbridge.md).

## Scope And Safety

- Keep changes minimal and scoped to the request. Avoid unrelated refactors or broad cleanup.
- Do not modify production code only to make a test pass. If a failing test points to a likely source issue, explain the issue and change behavior only when required by the task.
- Preserve cross-platform behavior: changes must work on Windows, macOS and Linux, especially paths, shell commands, environment variables and networking.
- Maintain compatibility with the supported Node.js versions: 22.13, 24 and 26.
- `matterbridge` is only a `devDependency` for build and tests, never add it to `dependencies`: at runtime the plugin uses the Matterbridge it is installed in.

## Testing And Validation

- HARD RULE: never invoke `tsc`, `vitest`, `oxlint` or `oxfmt` directly (via `npx`, `node node_modules/...` or any other ad hoc form). Always use the matching `package.json` script: `npm run typecheck`, `npm run lint` / `npm run lint:fix`, `npm run format` / `npm run format:check`, `npm run test` / `npm run test:coverage`, `npm run check` for everything. If there is no matching script, say so and ask before improvising.
- Run a single test file with `npm run test -- vitest/<file>.test.ts`. Run the full file rather than isolated single tests.
- Tests are TypeScript ESM files named `*.test.ts` in `vitest/`, grouped with `describe` and named `should [expected behavior] when [condition]`.
- Keep tests deterministic and simple with small data sets. Prefer clarity over clever setups.
- Some tests are intentional multi-step flows where state persists across steps of one test unit. Run them in full and keep each test unit isolated from the others.
- Coverage must stay at 90 % or more (`npm run test:coverage`), but prefer meaningful tests over coverage numbers.

## Documentation

- When behavior changes, update the relevant tests and [README.md](./README.md). There is no changelog file, release notes are generated from the merged pull requests.
