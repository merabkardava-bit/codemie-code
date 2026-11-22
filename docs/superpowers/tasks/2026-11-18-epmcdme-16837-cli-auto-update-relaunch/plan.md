# EPMCDME-16837 Relaunch after startup auto-update - Implementation Plan

**Goal:** After a successful silent startup auto-update, `bin/codemie.js` runs the original command in a fresh child process, so no CLI module loads from files that changed under cached old modules.

**Spec:** `spec.md` (same dir). **Analysis:** `technical-analysis.md`. Commit per task using the repository's existing convention.

**Conventions:** ES modules, `.js` import suffixes, `@/` alias inside `src/`, explicit return types, no `any`, `logger.debug` not `console.log`. `bin/` is plain JS. Tests are Vitest, in scope per spec AC3, AC4, AC7 and AC8. Bin-level tests need `npm run build` once first (`dist/` is absent). They strip `NODE_ENV`, `VITEST*`, `CODEMIE_*` and `npm_config_*` from the child env as `tests/integration/hook-stdout.test.ts:99-121` does.

**Out of scope (do not touch):** the prompt branch and its `process.exit(0)` (`cli-updater.ts:450`), `self-update.ts`, `update.ts`, interval/lock/`.last-update-check` logic, the 17 other `bin/*.js`, any new flag. No whole-suite gates, manual verification or git tasks here; later stages own them.

---

### T1 - `checkAndPromptForUpdate()` returns whether it installed

**Files:** `src/utils/cli-updater.ts:381-468` (doc comment above it too); tests `src/utils/__tests__/cli-updater.test.ts`, `src/utils/__tests__/utils-misc-coverage.test.ts:467-518`.

- [ ] Change the return type to `Promise<boolean>`. `true` only when the silent branch (`:405-421`) finished `updateCli(latest, true)` without throwing. Every other exit returns `false`: Connect install, interval not due, check failed or no update, lock not acquired, install threw (the catch at `:454`), prompt branch (decline or lock miss; the accept path still ends in `process.exit(0)`, unchanged).
- [ ] Plan note (arch review): right after `acquireUpdateLock()` succeeds, compare `getCurrentCliVersion()` (reads `package.json` each call) with `result.latestVersion`. When equal, skip `updateCli`, release the lock and return `false`. This closes the reinstall-under-the-child half of the concurrent-starter case. Replace the comment at `:417` ("let CLI continue ... next run").
- [ ] Do not import new exports from `processes.js`: `cli-updater.test.ts:17-20` mocks it with only `installGlobal` and `getLatestVersion`.

**Test-first:** yes - a test per branch asserting the return value (`true` after a silent install, `false` for each branch above), plus "already current after lock: `installGlobal` not called, lock released, `false`". Fails today because the function returns `undefined`.

### T2 - Builtin-only relay module `bin/relaunch.js`

**Files:** create `bin/relaunch.js` (shipped by `package.json` `files: bin`); test `tests/integration/relaunch.test.ts` (project `cli`).

Rule (arch review plan note): the module imports only `node:` built-ins and never `dist/`, so it works while `dist/` is being replaced and the 14 launchers can reuse it later.

```js
export const RELAUNCH_MARKER = 'CODEMIE_UPDATE_RELAUNCHED';
/** Read and delete the marker from env; true when it was set. Call before any dynamic import of dist. */
export function consumeRelaunchMarker(env = process.env) {}
/** Spawn execPath + filtered execArgv + script + args; inherit stdio, same cwd, env + marker=1.
 *  Never resolves: exits with the child's code, re-raises its signal, or exits 1 on spawn failure.
 *  Options (for tests): { script, args, execPath, execArgv, env, cwd, stdinIsTTY, platform }. */
export function relaunch(options) {}
```

- [ ] Exit: wait for the child, `process.exit(code)` (a number on Windows too). On a signal exit, remove the parent's own signal handlers first, then `process.kill(process.pid, signal)` (otherwise Node runs the handler, not the default action).
- [ ] Signal policy while waiting. POSIX with TTY stdin: no-op SIGINT handler, forward SIGTERM and SIGHUP only. POSIX without TTY: forward SIGINT, SIGTERM, SIGHUP. Windows: no-op SIGINT and SIGHUP, forward nothing (`child.kill` is a hard terminate, `signal-handlers.ts:86-90`).
- [ ] Spawn failure: treat the child `error` event as failure only when it arrives before `spawn`; write one stderr line saying the CLI was updated and the command should be re-run, exit 1. Never fall through.
- [ ] Do not replay `--inspect*` flags from `execArgv`.

**Test-first:** yes - tests drive `relaunch` through a throwaway driver script and a small child script: exit codes 0 and 7 pass through; argv, cwd and env reach the child with `CODEMIE_UPDATE_RELAUNCHED=1` added; `consumeRelaunchMarker` deletes it; a bad `execPath` gives the one-line stderr message and exit 1; a child killing itself with SIGTERM makes the driver die by SIGTERM (POSIX only). AC8 signal test (POSIX only, `skipIf(win32)`): driver started detached with `stdinIsTTY: true`, whole process group sent SIGINT via `process.kill(-pid, 'SIGINT')`, a child that counts SIGINTs into a file receives exactly 1. Fails because the module does not exist.

### T3 - Wire the relaunch into `bin/codemie.js` and pin the structure

**Files:** `bin/codemie.js:8-10` (add static import of `./relaunch.js`), `:44-46` (consume the marker before the dynamic imports of migrations and `cli-updater`), `:76-83` (gate); test `tests/integration/codemie-bin-relaunch-contract.test.ts`.

- [ ] Read the marker into a `const` before `:45`. Add it to the gate condition at `:77` so a relaunched child skips the update check; everything else (migrations, what's-new, the command) runs in the child as usual.
- [ ] At `:79` use the return value. On `true`: `await relaunch({ script: fileURLToPath(import.meta.url), args: process.argv.slice(2) })` straight away, before what's-new (`:92-107`) and `import('../dist/cli/index.js')` (`:110`). Script choice (arch review plan note): `import.meta.url` is realpath-resolved under a Unix symlink and is the file the `.cmd` shim names (`tests/helpers/npm-shims.ts`), so it is the installed `bin/codemie.js` in both cases; T4 exercises it.
- [ ] The existing swallow-all `try/catch` stays; `relaunch` never returns, so a `false` or a thrown error still reaches the old path only when no install ran.

**Test-first:** yes - a source-reading contract test fails until wired: `bin/relaunch.js` imports only `node:` specifiers and contains no `dist/`; in `bin/codemie.js` no `import(` appears between `await checkAndPromptForUpdate()` and the `relaunch(` call, and `relaunch(` precedes the first `whatsnew.js` and `cli/index.js` references.

### T4 - Fake-npm fixture and bin-level regression tests (AC3, AC4, AC6, AC8)

**Files:** create `tests/helpers/fake-npm-update.ts`; test `tests/integration/cli-startup-update-relaunch.test.ts`. Reuse the throwaway-package pattern at `hook-stdout.test.ts:508-516` (copy `bin`, `dist`, `package.json`, `src/utils/tips.json`; symlink `node_modules`).

- [ ] Fixture: temp package + temp `HOME`/`CODEMIE_HOME`; a fake `npm` (node script behind an `npm` shim on POSIX, `npm.cmd` on win32, dir first on `PATH`). It answers `view <pkg> version` with a newer version, `prefix -g` and `config get ...` with a temp path, and for `install -g ... pkg@ver` increments an install-count file and swaps files in the temp package: bump `package.json` version, append `export const relaunchProbe = true;` to `dist/utils/processes.js`, and prepend `import { relaunchProbe } from '../utils/processes.js';` to `dist/cli/index.js`. That is a new export on an already-loaded module, the ticket's failure. A second payload mode replaces `bin/codemie.js` with a recorder writing `{ argv, cwd, marker, scriptPath }` to a file.
- [ ] Runner: spawn `bin/codemie.js` from the temp package with the stripped env, stdin ended immediately, stdout and stderr piped (not TTY).
- [ ] Cases, each asserting exit 0, command output, no "does not provide an export named" and install count 1: `--version`, `doctor`, `list`, `analytics --help`, `update` (assert exit 0 and count 1 only). Plus `CODEMIE_UPDATE_CHECK_INTERVAL=0` still gives count 1 (AC6).
- [ ] Contract test (AC8): with the recorder payload, assert the parent spawned the installed `bin/codemie.js` with the literal env `CODEMIE_UPDATE_RELAUNCHED=1`, the original args and the original cwd. Use literals, not the exported constant, so a rename fails the test.
- [ ] Verify red once: temporarily ignore the `true` return in `bin/codemie.js`, confirm the AC3 case fails with the missing-export error, then restore.

**Test-first:** yes - the `--version` case fails without the relaunch with `The requested module '../utils/processes.js' does not provide an export named 'relaunchProbe'`.

### T5 - Changelog and configuration note

**Files:** `CHANGELOG.md` (`## [Unreleased]` at `:5`, under `### Fixed`; add the heading if absent), `docs/CONFIGURATION.md` (auto-update table at `:215-216`).

- [ ] Changelog: a startup auto-update now restarts the command once on the updated install, so `--version`, `--help`, `doctor`, `list` and `analytics` no longer crash with "does not provide an export named ...". State that it protects updates from this version on; users on an earlier 0.16.x see the crash once and run `npm i -g @codemieai/code@latest` once.
- [ ] `docs/CONFIGURATION.md`: two or three lines under the auto-update variables saying the command restarts once after an auto-update. Do not name the re-entry marker as a user switch. No other doc.

**Test-first:** no - documentation only, nothing to fail.

---

## Self-review

- Spec coverage: AC1/AC2 T3+T4; AC3 T4; AC4 T4; AC5 holds by structure (T3 relaunch precedes what's-new; not bin-testable, per spec); AC6 T2+T4; AC7 T1 (return values) + T2 (spawn-failure message); AC8 T2 (SIGINT count) + T4 (marker and script path).
- Arch-review plan notes: relay module and rule T2/T3; exit and failure preconditions T2 (handler removal, `error` before `spawn`, marker read before imports in T3, `--inspect*`, SIGKILL residual stays a spec risk); re-read after lock T1; script path T3 (import.meta.url) and T4 (fixture runs on win32 shims too).
- negative-constraints: honored. Prompt flow untouched (T1 keeps `:450`); `self-update.ts` and `update.ts` untouched; interval, lock and timestamp logic untouched (T1 only adds a version compare); no new flag or doc beyond CONFIGURATION.md and the changelog (T5); marker not documented as a switch (T5); no fall-through after spawn failure (T2); 17 other bins untouched; relaunch stays behind the existing gate condition so hook, scheduled, `--json`, test and Connect runs never relaunch (T3, T1).
