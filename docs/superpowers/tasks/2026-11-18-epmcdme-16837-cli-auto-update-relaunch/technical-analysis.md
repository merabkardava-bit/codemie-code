# Technical Research

**Task**: cli-updater auto-update bin/codemie.js re-exec
**Generated**: 2026-11-18
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-16837 (Bug) "CodeMie CLI startup auto-update crashes commands with missing module exports after successful installation". A command that triggers a successful startup auto-update can crash when the updated CLI imports exports absent from modules already cached by the running Node.js process. Reported: `codemie update` installs @codemieai/code@0.16.0 successfully, shows the changelog, then throws "Error: The requested module '../../../utils/processes.js' does not provide an export named 'isProcessAlive'". Cause: mixed old and new modules - bin/codemie.js loads cli-updater.js and the old processes.js; checkAndPromptForUpdate() replaces the installation but continues in the same process; subsequent imports load new files requiring exports unavailable in the cached old module. Reproduced 0.16.3 -> 0.16.4 with missing listDescendants; persists on main at 94908d6a. Also doctor --help, list --help, analytics --help fail when they trigger the update. Reported missing exports: 0.15.9 getPlatformUrl; 0.16.0 isProcessAlive; 0.16.3 signalTree; 0.16.4 listDescendants. Scheduled commands fail without automatic second attempt. Suggested fix: after a successful startup auto-update, re-execute the original command in a fresh process rather than continuing with cached modules. Related: EPMCDME-16753 (CLI silently updates on startup and can become unusable if interrupted). Source: GitHub issue #683. Repro: isolated npm prefix and HOME, npm install -g --ignore-scripts @codemieai/code@0.16.3, with 0.16.4 available and update check due run `codemie --version`; second invocation works. Acceptance criteria: (1) after successful startup auto-update, execution does not mix cached old modules with newly installed files; (2) original command and arguments execute successfully against the updated CLI without manual retry; (3) regression tests cover an upgrade that adds an export to a previously loaded module; (4) tests cover version, doctor, list, and analytics commands triggering an update, including non-interactive execution; (5) `codemie update` completes cleanly after installation and changelog output; (6) if re-execution is used, it preserves original arguments, working directory, environment, and command exit status without an update loop.

Starting hints from an earlier (possibly stale, written against 7f28135e/0.16.9) analysis — verify against current HEAD, do not trust: the seam is bin/codemie.js (startup update gate ~lines 76-83, whatsnew ~92-107, dynamic import of ../dist/cli/index.js ~110) and src/utils/cli-updater.ts checkAndPromptForUpdate() (silent branch continues; prompt branch process.exit(0)). Precedents for re-launch: src/utils/exec.ts exec(), src/cli/commands/skills/lib/run-skills-cli.ts spawn(process.execPath,...), analytics/sync/scheduler/generators.ts. Existing tests: src/utils/__tests__/cli-updater.test.ts, utils-misc-coverage.test.ts, tests/integration/hook-stdout.test.ts (only bin-level test with update enabled), tests/helpers/isolated-cli.ts. Recent commit 608d79a1 "serve every client from one proxy daemon" may have touched startup — check.

---

## 2. Codebase Findings

Project: Node >=20 ESM TypeScript package `@codemieai/code` 0.16.10 (`package.json`), built to `dist/`, Vitest. HEAD 608d79a1; `bin/codemie.js` and `src/utils/cli-updater.ts` were last touched by 62bced1c / 01f46cf3 — **608d79a1 did not touch either** (hint checked: no).

### Existing Implementations

**Purpose A: after a startup update, run the user's original command on the new code only**
- None found that re-launches the CLI after an update. Searched `relaunch|re-exec|reexec|CODEMIE_(UPDATED|RELAUNCH|SKIP_UPDATE)` and `spawn(process.execPath` in `src/` (non-test): only `run-skills-cli.ts:113` (spawns a *different* script, `skillsBin`, with `stdio` inherit/pipe, `cwd`, `env`, `windowsHide`), `hook-command.ts:76` and `analytics/sync/scheduler/generators.ts:28-32` (both resolve `process.argv[1]` via realpath to *write* a command line for hooks / OS scheduler, not to spawn).
- Startup gate: `bin/codemie.js:76-83`. `await checkAndPromptForUpdate()` inside try/catch that swallows everything; skipped when `NODE_ENV==='test'`/`VITEST==='true'` (line 76), hook process (`argv[2]` is `hook`|`sound`, line 27), scheduled sync run (`isScheduledSyncRun`, `src/utils/scheduled-run.ts`), or `--json` (`isMachineOutputInvocation`, `src/utils/machine-output.ts:13`; stops at `--`). Nothing receives a "was updated" signal: `checkAndPromptForUpdate(): Promise<void>`.
- The mixed-module window: `bin/codemie.js` statically imports `dist/utils/logger.js`, `scheduled-run.js`, `machine-output.js` (lines 8-10) and dynamically `dist/migrations/index.js`, `dist/utils/cli-updater.js` (45-46). `cli-updater.ts:21` imports `./processes.js` (`getLatestVersion` :467, `installGlobal` :292), so old `processes.js` is cached before the install. Install is `exec('npm', ['install','-g',...prefixArgs,'--force', pkg@ver])` (`processes.ts:310-316`) overwriting `dist/` in place. Then `bin/codemie.js:95` loads `dist/utils/whatsnew.js` (new file, prints CHANGELOG notes of the new version when stdout is a TTY — this is the "shows the changelog") and `:110` `import('../dist/cli/index.js')` loads the new command graph against cached old `processes.js`/`logger.js`. Missing exports named in the ticket are all in `src/utils/processes.ts` today: `isProcessAlive` :121, `signalTree` :208, `listDescendants` :233.
- Silent branch: `cli-updater.ts:405-421` — acquires `.update-lock`, `updateCli(latest, true)`, releases lock, `return` (comment line 417: "Don't exit - let CLI continue with updated version on next run"). Install failure: `updateCli` prints a red failure + manual command and rethrows (`:298-318`) → caught at `:454`, lock released, logged, startup continues on the old install.
- Prompt branch (`CODEMIE_AUTO_UPDATE=false`): `cli-updater.ts:425-453` — inquirer confirm; on yes `updateCli(latest, false)` then `process.exit(0)` (:450), so the user's original command is dropped (not run) after a prompted update. Prompt writes to stdout and reads stdin.
- Loop protection already present: `recordUpdateCheck()` writes `~/.codemie/.last-update-check` at `:396`, *before* the install, and `shouldCheckForUpdate()` (:80-95) gates on `UPDATE_CHECK_INTERVAL` (`CODEMIE_UPDATE_CHECK_INTERVAL`, default 24h, read once at module load :31-34). `CODEMIE_UPDATE_CHECK_INTERVAL=0` (or a failed timestamp write) defeats it; no env/argv re-entry marker exists. Concurrency guard: `.update-lock` with 10-min stale reclaim (:40, :114-149).
- Post-install reporting: `updateCli` → `reportUpdateResult` (`:331-365`) calls `verifyActiveCli` (`src/utils/active-cli.ts:174`, PATH lookup/file reads; spawns only `npm` for the prefix hint when not silent) and prints "will take effect on the next command" when verdict is `current` (:359).
- Other entry points that update the CLI package: `codemie self-update` (`src/cli/commands/self-update.ts:56`, calls `updateCli(latest,false)` in-process, then keeps running to print status) and `codemie update` (`src/cli/commands/update.ts:215-217`, built-in agent: `npm.installGlobal(CLI_PACKAGE_NAME…)` in-process; then `agent.warnOnceIfUntested()` :233 and `restoreCliBinLink()` :311/391 (`src/utils/cli-bin.ts`, no-op on win32) — code that runs after the package on disk was replaced). `update <builtin>` prints "cannot be updated externally" (:265-268). Whether this in-command path hits the same missing-export failure was not reproduced; the ticket's `codemie update` symptom matches the startup path (install → what's-new → dynamic import).
- Only `bin/codemie.js` calls `checkAndPromptForUpdate` (grep across `src/`, `bin/`); the other 17 `bin/*.js` entries (agent shortcuts, `proxy-daemon.js`, `codemie-mcp-proxy.js`) have no update check.

**Purpose B: report/keep the child's exit status and stdio contract**
- `src/cli/index.ts:124-131` calls `process.exit(0|1)` in places; `bin/codemie.js:15-20` swallows EPIPE (exit 0) on stdout/stderr; `:110-113` prints `Error: <msg>` and `exit(1)` for a failed import (the exact crash text in the ticket).
- `src/utils/exec.ts:36` `exec()` always `spawn`s with `env: {...process.env, ...options.env}`, `cwd: options.cwd || process.cwd()`, `windowsHide`, `stdio` `pipe` unless `interactive` (then `inherit`); resolves `{code,stdout,stderr}`; **rejects when the child dies from a signal** (:112-114). It is the helper `installGlobal` uses.

**Other touched code**: `src/utils/whatsnew.ts:298` `shouldRunUpgradeNotice` (TTY-only, skips `--version/-V/--task/--help` via `OUTPUT_CONTRACT_ARGS`, `hook`); `src/utils/paths.ts` `getCodemiePath()` (home for lock/timestamp).

### Decisions Already in the Code
- Update install is in-process and the process continues (silent) — comment `cli-updater.ts:417` "let CLI continue with updated version on next run"; alternative (re-launch) not implemented; reason recorded: none found beyond that comment.
- Startup update is best-effort and never blocks the CLI: swallow-all try/catch `bin/codemie.js:78-82`, `cli-updater.ts:454-467`.
- Machine-output / hook / scheduled invocations opt out of update work entirely (`bin/codemie.js:27,37,42,77`); docs state this for hooks (`docs/CONFIGURATION.md:222`). A `codemie --version` run is **not** exempt from the update (control test in `hook-stdout.test.ts:168` proves it prints migrations and queries the registry).
- Convention for child processes: `spawn(process.execPath, [script, ...args], {cwd, env, stdio, windowsHide: platform==='win32'})` (`run-skills-cli.ts:113-118`); `exec()` is the shared wrapper for npm/CLI calls (AGENTS.md "Common Pitfalls"). Hard-coded `~/.codemie` is disallowed in favour of `getCodemiePath()`.
- Imports use `.js` extensions; `@/` alias; errors via project error classes; `logger.debug` not `console.log` (AGENTS.md).
- Test bypass: `NODE_ENV==='test'` or `VITEST==='true'` disables the whole update gate in `bin/codemie.js`; vitest sets `NODE_ENV=test` in all three projects (`vitest.config.ts:31,67,90`), so a bin-level update test must strip these (as `hook-stdout.test.ts:99-108` does).

### Task Statements Checked Against the Code
- "bin/codemie.js loads cli-updater.js and the old processes.js; checkAndPromptForUpdate() replaces the installation but continues in the same process": **holds** (`bin/codemie.js:46,79`; `cli-updater.ts:21,416-421`).
- "subsequent imports load new files requiring exports unavailable in the cached old module": **holds mechanically** (`bin/codemie.js:95,110`); missing-export examples are present in current `processes.ts` (:121, :208, :233). Specific historical versions (0.15.9 getPlatformUrl etc.) unverified here (outside this checkout; npm tarballs would settle it).
- "persists on main at 94908d6a": **unverified** as a SHA (HEAD is 608d79a1); the code path it describes is unchanged at HEAD.
- "doctor --help, list --help, analytics --help fail when they trigger the update": **holds as a consequence** — no argv exemption in the gate for `--help`; only the *notice* skips `--help` (`whatsnew.ts:298-303`), the update does not.
- "Scheduled commands fail without automatic second attempt": **contradicted in part** for `analytics sync run --scheduled`: it skips the update gate (`bin/codemie.js:37,77`). Other scheduled/unattended invocations (anything not matching `isScheduledSyncRun`) do run the gate. Note the stale record the "scheduled run" in `generators.ts` refers to the same `bin/codemie.js`.
- "`codemie update` installs … shows the changelog, then throws": **holds for the startup path** (install, `whatsnew.js` at :95, then import at :110). The command's own in-process self-install (`update.ts:215`) is a second route; not reproduced.
- "Suggested fix: re-execute the original command in a fresh process": **keeps in place / interacts with**: (a) prompt-branch `process.exit(0)` (`cli-updater.ts:450`) which today intentionally ends the process after update; (b) the silent-branch `return`; (c) the what's-new notice at `bin/codemie.js:92-107`, which today runs in the *updating* process; (d) `reportUpdateResult` text "will take effect on the next command" (`:359`).
- "second invocation works": **holds** by the `.last-update-check` timestamp (`:396`, written before install) — no network/install on next run within 24h.
- AC6 "without an update loop": existing timestamp guard (`:80-95,396`) covers default settings only; see Risk Indicators.

### Consumers of Changed Contracts
- `checkAndPromptForUpdate()` (void return): sole caller `bin/codemie.js:79`; tests `src/utils/__tests__/cli-updater.test.ts:28,102,122`, `utils-misc-coverage.test.ts:467-518` (all assert `Promise<void>`/side effects, no return-value use). Mocks of the module elsewhere (`self-update.test.ts:6`, proxy tests `index.test.ts:51`, `daemon-manager.test.ts:39`, `connect-orchestrator.test.ts:49`, `claude-code-otlp*.test.ts:44/43`, `config-update-profile.test.ts:14`) only stub `getCurrentCliVersion`/`updateCli`/`isAutoUpdateEnabled`/`checkForCliUpdate`.
- `updateCli(version, silent)` (void): callers `cli-updater.ts:416,447` and `self-update.ts:56`; mocked in `self-update.test.ts:9`. `reportUpdateResult` is module-private.
- `process.argv`/`process.argv[1]` of `bin/codemie.js` is also consumed as the re-launch identity by scheduler job generation (`generators.ts:28-32`, realpath) and `hook-command.ts:76`; the shim layout npm writes (`tests/helpers/npm-shims.ts`) execs `node …/node_modules/@codemieai/code/bin/codemie.js "$@"`.
- Behaviours that today happen in the updating process and would be observable to callers if a child ran the command: stdout/stderr ordering, TTY inheritance (`process.stdout.isTTY` gating the notice and prompts), stdin consumption, exit code/signal, `CODEMIE_*` env, migrations run (`bin/codemie.js:45-70`, runs before the update gate, so a re-launched process would run `hasPending()` again).

### Architecture and Layers Affected
- Entry wrapper (`bin/codemie.js`, plain JS outside `src/`, excluded from coverage `vitest.config.ts:43`) and utils layer (`src/utils/cli-updater.ts`, `exec.ts`, `processes.ts`). CLI layer (`src/cli/commands/update.ts`, `self-update.ts`) is adjacent. Build output `dist/` is what the wrapper imports; `package.json:files` ships `dist`, `bin`, `scripts`.

### Integration Points
- npm global install (`npm install -g --force`, prefix from `getNpmPrefixArgs`), `~/.codemie/.last-update-check` and `.update-lock`, npm registry (`getLatestVersion`, 5s timeout), npm bin shims on Windows (`.cmd`) and Unix symlinks, `scripts/postinstall.mjs`.

### Patterns and Conventions
- Module-level env constants read at load (`UPDATE_CHECK_INTERVAL`, lock paths) — tests use `vi.resetModules()` + `loadUpdater()` (`utils-misc-coverage.test.ts:396`).
- Boolean env parsing via `parseBooleanEnv` (`src/utils/env.ts`); Windows spawns use `shell`/`windowsHide` handling in `exec.ts`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` present (architecture, development, integration, security, standards, testing, usage; `quality-gates.md`, `project.md`) — not opened in depth; AGENTS.md summarises them. `docs/CONFIGURATION.md:211-230` and `docs/COMMANDS.md:1495-1542` document auto-update (`CODEMIE_AUTO_UPDATE`, `CODEMIE_UPDATE_CHECK_INTERVAL`); `docs/COMMANDS.md:1542` says the update "takes effect once the codemie first on your PATH is the updated install". No doc describes a re-launch.
- Prior task analyses touching the same code: `docs/superpowers/tasks/2026-09-30-no-self-update-in-connect/`, `2026-11-07-epmcdme-16080-self-update-path-check/`, `2026-11-05-epmcdme-16716-analytics-status-json-stdout/`.

### Architectural Decisions
- None recorded for "continue vs re-launch after update" (searched `docs/`, inline markers in `cli-updater.ts`/`bin/codemie.js`; only the comment at `cli-updater.ts:417`). Connect installs never self-update (`cli-updater.ts:12,383`).

### Derived Conventions
- Start-up chatter must stay off stdout for `--json`, hooks and unattended runs (comments `bin/codemie.js:22-42`); CODEMIE_TIPS/what's-new shares opt-out switches.

---

## 4. Testing Landscape

### Existing Coverage
- `src/utils/__tests__/cli-updater.test.ts`: `updateCli` failure fallback text, Connect marker (mocks `processes.js`, `paths.js`, `logger.js`, `npm-prefix.js`, `fs.access`), `checkAndPromptForUpdate` calls `getLatestVersion` when no marker. No test of the post-install behaviour of the silent branch beyond `utils-misc-coverage.test.ts:488-500` (install called once with `force:true`, timestamp written, lock released) and prompt-decline `:509`. **No test covers the prompt-accept path** (`process.exit(0)` at :450) or a return value.
- `tests/integration/hook-stdout.test.ts` (project `cli`): spawns real `bin/codemie.js` via `process.execPath`, local HTTP server as npm registry (`npm_config_registry`), strips `CODEMIE_*`, `VITEST*`, `NODE_ENV`, `npm_config_*` (lines 99-120) so update gate runs; registry answers 404 so **no update ever installs** in any bin-level test. Control cases `version`/`--version` assert registry was hit (:158-175). Also copies `bin`, `dist`, `package.json` into a temp package with symlinked `node_modules` (:508-516) — a pattern for a throwaway install tree.
- `tests/integration/cli-commands/{version,doctor,list,help,self-update}.test.ts` exist (small, 0.9-2 KB); `self-update.test.ts` runs the repo's bin without isolation (`env: {...process.env}`) so under vitest `NODE_ENV=test` skips the gate.
- `tests/helpers/isolated-cli.ts` `runIsolatedCli` (spawnSync, private `CODEMIE_HOME`/`HOME`, supports `pathPrefix` to inject a fake binary; passes through `NODE_ENV`/`VITEST` from `process.env`, so would also skip the gate unless overridden via `options.env`); `tests/helpers/npm-shims.ts` (win32 shim text); `tests/helpers/cli-runner.ts`.

### Testing Framework and Patterns
- Vitest (projects `unit`: `src/**/*.test.ts`; `cli`: `tests/integration/**` minus `agent-*`; `agent`: network). Dynamic-import mocking after setup per `.ai-run/guides/testing/testing-patterns.md`. Temp `CODEMIE_HOME` per test, `vi.resetModules()`.

### Coverage Gaps
- `bin/codemie.js` has no unit coverage (excluded) and no test where an update actually installs. No fake npm that swaps `dist/` files, no test of a changed export set across an update, no test combining update + `doctor/list/analytics/--version/--help`, none for non-interactive (stdin closed / non-TTY) update, none for exit-status/argv/cwd/env preservation through a launcher. Prompt-accept branch untested.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_AUTO_UPDATE` (default true; `parseBooleanEnv`), `CODEMIE_UPDATE_CHECK_INTERVAL` (ms, default 86400000, read at module load), `CODEMIE_HOME` (state dir via `getCodemiePath`), `CODEMIE_TIPS` (what's-new off switch), `NODE_ENV=test`/`VITEST=true` (disable gate), `CODEMIE_DEBUG`, `npm_config_registry` (used by tests for a fake registry).

### Configuration Files
- `~/.codemie/.last-update-check` (epoch ms), `~/.codemie/.update-lock` (exclusive-create, 10-min stale), `~/.last-seen-version` under the home (what's-new marker), `codemie-connect.json` next to `package.json` (Connect marker).

### Feature Flags and Deployment Concerns
- No flag for re-launch. Distribution is npm global install with per-OS shims (Unix symlink to `bin/codemie.js`; Windows `.cmd` → `node …\bin\codemie.js %*`). `scripts/postinstall.mjs` runs on install (the ticket's repro uses `--ignore-scripts`). Working tree has an uncommitted change to `.codemie/codemie-cli.config.json` (unrelated).

---

## 6. Risk Indicators

- Existing mechanism for the same purpose kept in place by a task statement: the prompt branch ends the process with `process.exit(0)` after update (`cli-updater.ts:450`), which drops the user's command; the task's AC2/AC6 wording ("original command executes without manual retry") does not say whether that branch is in scope (see Task Statements, Consumers).
- Loop guard rests on `.last-update-check` written before install (`cli-updater.ts:396`); `CODEMIE_UPDATE_CHECK_INTERVAL=0`, an unwritable home, or a new version that still reports older than npm `latest` would let a child process update again. Speculative: AC6 needs a guard independent of that file (e.g. a re-entry marker passed to the child).
- Speculative: a child process re-runs `MigrationRunner.hasPending/runPending` (`bin/codemie.js:45-70`) and the whole startup output; migrations/chatter placement relative to the update is a behaviour decision (stdout for `--json` is already protected because the gate is skipped there).
- TTY/stdin/exit-status fidelity: `exec()` pipes stdio unless `interactive`, resolves null-code (signal) as a rejection (`exec.ts:112`), and sets `windowsHide`; interactive commands (`setup`, prompts, `codemie-code` agents launched through `codemie`) need inherited stdio — Speculative: the existing helper does not provide pass-through exit/signal semantics by itself.
- Windows: `process.argv[1]` may be a shim-resolved path; updated install path may differ from the running one if prefix/PATH differ (`active-cli.ts` "stale" verdict, `cli-updater.ts:354`); `.cmd` shims and in-use-file replacement on Windows during `npm install -g --force` of a running process.
- `bin/codemie.js` is plain JS, un-linted for types, excluded from coverage and unit-testable only through a spawned process; a real-install regression test (AC3/AC4) needs a fake registry and a replaceable `dist/` — heavier than any current bin test (`hook-stdout.test.ts` only 404s the registry). Under vitest the gate is off unless `NODE_ENV`/`VITEST` are stripped.
- Update paths outside the startup gate (`codemie update` built-in install `update.ts:215`, `self-update.ts:56`) continue running old in-memory modules after replacing files; AC5 names `codemie update`. Not reproduced here.
- Existing test mocks (`processes.js` mocked with only `installGlobal`/`getLatestVersion`) would break if cli-updater started importing other `processes.js` exports (`cli-updater.test.ts:17-20`).
- Hook (`isHookProcess`), `--json`, scheduled-sync and Connect installs all bypass the update gate; any new re-launch must stay behind the same gate (`bin/codemie.js:77`).

---

## 7. Summary for Complexity Assessment

The seam is small and well-isolated: `bin/codemie.js` (startup gate at :76-83, dynamic CLI import at :110) and `src/utils/cli-updater.ts` (`checkAndPromptForUpdate` :381-468, silent branch :405-421, prompt branch :425-453). The bug is confirmed at HEAD: `cli-updater.js` pulls `processes.js` into the module cache before `npm install -g --force` overwrites `dist/`, and the process then imports `dist/cli/index.js` (and the what's-new module) from the new tree. Commit 608d79a1 did not touch the startup path. No re-launch mechanism exists anywhere in the repo; process-spawn conventions exist (`exec.ts`, `run-skills-cli.ts`) but with piped-stdio/signal semantics that differ from a transparent pass-through. Adjacent in-process update paths (`codemie update`, `self-update`) also run after files are replaced.

File surface is small (2-3 source files plus docs/CHANGELOG), but behavioural surface is wide: argv/cwd/env/stdio/TTY/exit-status/signal fidelity across Unix and Windows shims, loop prevention that does not rely only on the timestamp file, interaction with the prompt branch's `process.exit(0)`, migrations and the what's-new notice, and the opt-outs (hook, `--json`, scheduled, Connect).

Test posture: unit tests for the updater exist and mock `processes.js` narrowly; the only bin-level update-enabled harness (`hook-stdout.test.ts`) never installs anything, `bin/codemie.js` has no coverage, and `NODE_ENV=test` disables the gate. AC3/AC4 need a new bin-level fixture (temp package copy with a fake registry/npm that swaps files and adds an export, run for `--version`, `doctor`, `list`, `analytics --help`, non-TTY/closed stdin). Key risks are listed in Section 6; the highest is that AC4/AC6 test infrastructure is new work, not an extension of an existing helper.

---

## 8. External References

None named by the task. (The Jira ticket, GitHub issue #683, EPMCDME-16753 and the npm versions 0.15.9/0.16.0/0.16.3/0.16.4 are mentioned only as context; none were resolvable from the filesystem and none were fetched.)
