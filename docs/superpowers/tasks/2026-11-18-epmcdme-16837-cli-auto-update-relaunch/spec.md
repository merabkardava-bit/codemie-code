# EPMCDME-16837: relaunch the CLI after a startup auto-update

## Problem

`bin/codemie.js` imports `dist/utils/cli-updater.js`, which pulls the old `processes.js` into the module cache (`cli-updater.ts:21`). The silent branch of `checkAndPromptForUpdate()` then runs `npm install -g --force`, which overwrites `dist/` (`cli-updater.ts:405-421`). The process continues, loads what's-new (`bin/codemie.js:95`) and imports `dist/cli/index.js` (`:110`). The new command graph runs against the cached old modules, so it fails with "does not provide an export named ..." (for example `isProcessAlive` at `processes.ts:121`). The gate has no argv exemption, so `--version`, `--help`, `doctor`, `list` and `analytics` all hit it.

## Behavior

- `checkAndPromptForUpdate()` returns `Promise<boolean>`: `true` only when the silent auto-update installed without throwing, in this process. Every other path returns `false`: no update due, check failed, lock not acquired, install failed, prompt branch, Connect install. The prompt branch is unchanged, including `process.exit(0)` at `cli-updater.ts:450`.
- `bin/codemie.js` acts on `true` immediately, before what's-new and before importing `dist/cli/index.js`. It spawns `process.execPath` with `process.execArgv`, this script and the original `argv.slice(2)`. The child gets inherited stdio, the same cwd and the same env plus a one-shot re-entry marker (`CODEMIE_UPDATE_RELAUNCHED=1`).
- The child deletes the marker from `process.env` at startup. It skips the update gate when the marker was present. Everything else (migrations, what's-new, the command) runs in the child from the new files only. The user's command and any process it launches see the original env. The marker is internal: it is not documented as a user switch, and setting it by hand disables the update gate for that process.
- The parent waits for the child and exits with the child's exit code. If the child dies from a signal, the parent removes its own signal handlers and re-raises that signal on itself.
- Signal policy while the parent waits, per platform:
  - POSIX with a TTY on stdin: the child shares the foreground process group, so the terminal already delivers Ctrl+C to it. The parent keeps a no-op SIGINT handler so it stays alive and forwards only SIGTERM and SIGHUP.
  - POSIX without a TTY on stdin: the parent forwards SIGINT, SIGTERM and SIGHUP.
  - Windows: the console delivers Ctrl+C to both processes and `child.kill` is a hard terminate (`signal-handlers.ts:86-90`), so the parent keeps no-op SIGINT and SIGHUP handlers and forwards nothing.
- If the spawn itself fails, the parent writes one line to stderr saying the CLI was updated and the command should be re-run, then exits 1. It never falls through to the mixed-module import.
- The relaunch sits behind the existing gate condition (`bin/codemie.js:77`). Hook, scheduled-sync, `--json`, test-env and Connect invocations never update, so they never relaunch.
- Migrations stay ahead of the update gate. After a relaunch the child re-checks pending migrations with the new code.
- The marker name and the entry script path are an internal cross-version contract: the outgoing version spawns, the incoming version reads. Changing either breaks updates from every version that carries this relaunch.

## Acceptance criteria

1. After a successful startup auto-update run by this process, the running process imports no CLI module. The command runs only in a fresh process. Concurrent starters and failed or timed-out installs are outside this criterion (see Risks).
2. From the fixed version on, the original command and arguments run against the updated CLI without a manual retry, for `--version`, `--help`, `doctor`, `list` and `analytics`. An update out of a version without this relaunch still crashes once; the changelog entry gives the one-time manual step (`npm i -g @codemieai/code@latest`).
3. A regression test covers an upgrade that adds an export to an already-loaded module (`processes.js`). It fails without the relaunch and passes with it.
4. Bin-level tests run `--version`, `doctor`, `list`, `analytics --help` and `codemie update` through a real update with the update due. They use a throwaway copy of the package, a fake registry and a fake `npm` that swaps `dist/` files. Every case also runs with stdin closed and stdout and stderr not a TTY, asserting exit code 0, the command output and an install count of 1 (the same assertions for `codemie update`). The harness strips `NODE_ENV` and `VITEST` as in `tests/integration/hook-stdout.test.ts:99-108`.
5. `codemie update` completes cleanly after the install: one install, exit 0, no crash (tested at bin level under AC4). The what's-new notice shows only on a TTY (`bin/codemie.js:97`), so "changelog shown once, by the child" is not observable at bin level and is not covered by a bin test; it holds by structure, because the relaunch returns before the what's-new block.
6. The relaunch preserves argv, cwd, env (apart from the deleted marker), exit code and signal exit. Exactly one install happens even with `CODEMIE_UPDATE_CHECK_INTERVAL=0`.
7. Unit tests cover the `checkAndPromptForUpdate()` return value in each branch, and the spawn-failure message with exit 1.
8. A bin-level test with a child that counts the SIGINTs it receives, run while the parent's process group is signalled, shows the child receives one on POSIX with a TTY. A bin-level test fails if the marker name or the entry script path the parent spawns changes.

## Non-goals

- The prompt flow (`CODEMIE_AUTO_UPDATE=false`) is unchanged: it installs, prints and exits, and the typed command is not run.
- The in-command installs in `self-update.ts:56` and `update.ts:215-233` (built-in agent) are not changed.
- Closing the concurrent-starter and failed or timed-out install windows (waiting on the update lock, relaunching after an attempted install, a shared install-outcome type) is not part of this change.
- The update-check interval, the lock and the `.last-update-check` logic are unchanged.
- No new CLI flag, and no new doc beyond a short note in `docs/CONFIGURATION.md` and the changelog.
- The 17 other `bin/*.js` entries and the hook, scheduled and `--json` opt-outs are unchanged.

## Decisions

- Relaunch with `spawn(process.execPath)` and inherited stdio over `exec()`, which pipes stdio and rejects on signal death (`exec.ts:112`).
- `checkAndPromptForUpdate()` returns a boolean and `bin/codemie.js` does the relaunch, over relaunching inside `cli-updater.ts`.
- Relaunch before what's-new and the CLI import over after, so the child shows the notice once and runs only new code.
- Migrations stay before the update gate over moving the gate ahead of them.
- An env marker deleted by the child is the loop guard, over relying only on `.last-update-check`.
- On spawn failure, print a re-run message and exit 1 over falling through to the old import.
- A dedicated fake-npm bin-level fixture over extending the registry-404 harness.
- A per-platform signal policy (no second SIGINT on a POSIX TTY, no forwarding on Windows) over forwarding SIGINT and SIGTERM everywhere.
- State the concurrent-starter and failed or timed-out install windows as residual risks and word AC1 for a successful install by this process, over closing them here with a lock wait and an install-outcome type.
- State that the relaunch protects updates only from the fixed version on, with the one-time manual step in the changelog, over claiming protection for every update.
- Leave the prompt flow exactly as it is, including `process.exit(0)` at `cli-updater.ts:450` — user.
- Fix the startup relaunch only. The in-command installs (`self-update`, `update` of the built-in agent) are a known residual risk, left for a follow-up if a crash is reproduced — user.

## Risks

- Concurrent starters: a second codemie command that starts while another installs passes the interval gate (the timestamp is written before the install, `cli-updater.ts:396`) or fails to get the lock (`:408-411`). It then continues with old cached modules against files npm is rewriting, and a late starter can reinstall under the winner's child. Not made worse and not closed by this change.
- A failed or timed-out install (60 s, `cli-updater.ts:295`) after npm began replacing files returns `false` and continues in the old process against changed files. Not reproduced. Re-reading the installed version after taking the lock and skipping an install that is already current is a candidate follow-up.
- First hop: users on today's 0.16.x crash once when updating into the fixed release, because the outgoing version runs the gate. The next command works.
- SIGKILL of the parent leaves the child running; accepted.
- Windows: `npm install -g --force` replaces files of a running install. The relaunch does not change this. The script path (`process.argv[1]` or `import.meta.url`) under a Unix symlink and the Windows `.cmd` shim is to be settled and exercised once on Windows in the plan.
- The installed path can differ from the running path (`cli-updater.ts:354` "stale" verdict). The relaunch is then harmless (the marker prevents a loop) but runs the old code again.
- In-command installs may still run old modules after replacing files. Not reproduced; ask the reporter which route the `codemie update` repro took.
- The 14 launchers and two daemons run no update gate and keep the in-place replacement risk; no owner is named for a follow-up.
- The historical missing exports were checked only against the current `processes.ts`, not the npm tarballs.
