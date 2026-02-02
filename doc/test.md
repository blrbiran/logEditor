# LogEditor Test Guide

## Overview
- **Unit tests (Node)** live under `src/main/**/*.test.ts` and cover filesystem/search services using Vitest in a pure Node environment (`vitest.config.main.ts`).
- **Renderer integration tests** use Vitest + React Testing Library (`vitest.config.renderer.ts`) to exercise hooks/components such as `useTabsController` with a jsdom DOM and the stubbed `window.api`.
- **End-to-end (E2E) tests** leverage Playwright’s Electron runner (`e2e/*.spec.ts`) to boot the compiled desktop app and assert preload + UI wiring.
- Coverage is provided by `@vitest/coverage-v8`; unit and renderer suites each emit their own reports (`coverage/unit`, `coverage/renderer`).

## Prerequisites
1. Install project dependencies: `npm install`.
2. Install Playwright’s browser/electron binaries once per machine: `npx playwright install --with-deps`.

## Day-to-day Commands
| Goal | Command | Notes |
| --- | --- | --- |
| Run all unit + renderer suites once | `npm run test` | Executes the Vitest workspace (Node + jsdom). |
| Watch tests during development | `npm run test:watch` | Re-runs affected specs across both configs. |
| Node-only unit tests | `npm run test:unit` | Targets `src/main` and shared modules. |
| Renderer integration tests | `npm run test:renderer` | jsdom + Testing Library; consumes `tests/setup-renderer.ts`. |
| Collect coverage reports | `npm run test:coverage` | Generates text summary + LCOV/HTML per suite under `coverage/*`. |
| Electron E2E smoke test | `npm run test:e2e` | Builds the app, then runs Playwright specs from `e2e/`. |
| Inspect Playwright runs interactively | `npm run test:e2e:dev` | Launches Playwright UI without rebuilding. |

## Coverage Details
- Coverage uses V8 instrumentation; no Babel plugin required.
- Reports:
  - `coverage/unit`: Node/main process coverage (HTML + LCOV for CI).
  - `coverage/renderer`: Renderer integration coverage.
- Combine coverage in CI by merging LCOV files if desired, e.g. `lcov-result-merger "coverage/*/lcov.info"`.

## E2E Workflow Tips
- `npm run test:e2e` automatically runs `npm run build` to ensure `out/main/index.js` exists.
- Artifacts: HTML report under `playwright-report/`, raw traces/videos under `test-results/` when failures occur.
- To debug locally, add `DEBUG=1` or open the Playwright trace viewer: `npx playwright show-report`.

## Adding New Tests
- Co-locate specs beside the modules they cover (`*.test.ts[x]`) to inherit tsconfig path aliases.
- Renderer tests can rely on the global `window.api` proxy from `tests/setup-renderer.ts`; explicitly `vi.spyOn` methods you assert.
- For filesystem-heavy tests, prefer temporary directories via `fs.mkdtemp` to avoid polluting the repo; helper patterns already exist in `src/main/*.test.ts`.
- Playwright specs should remain fast and deterministic—mock large file operations through preload IPC when possible so the compiled bundle stays small.
