/**
 * Relaunch relay for the codemie launchers.
 *
 * After a startup auto-update replaced the package files on disk, the running process
 * still holds modules loaded from the old files, so a later lazy import can resolve against
 * the new ones and crash. The launcher then runs the same command again in a fresh child
 * process and relays its exit status.
 *
 * Imports only `node:` built-ins and never anything under `dist/`: it runs while `dist/` is
 * being replaced, and any launcher can reuse it.
 */

import { spawn } from 'node:child_process';
import { isatty } from 'node:tty';

/** Set on the child so it skips the update check and cannot relaunch again. */
export const RELAUNCH_MARKER = 'CODEMIE_UPDATE_RELAUNCHED';

/**
 * Read and delete the marker from env; true when it was set.
 * Call before any dynamic import of dist, so nothing downstream sees or inherits it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function consumeRelaunchMarker(env = process.env) {
  const wasSet = env[RELAUNCH_MARKER] === '1';
  delete env[RELAUNCH_MARKER];
  return wasSet;
}

/**
 * Which signals the waiting parent forwards to the child, and which it swallows.
 * A terminal sends Ctrl+C to the whole foreground process group, so the child already has
 * it; forwarding would deliver it twice. A bare `child.kill()` on Windows is a hard
 * terminate, so nothing is forwarded there.
 *
 * @param {string} platform
 * @param {boolean} stdinIsTTY
 * @returns {{ ignore: string[], forward: string[] }}
 */
function signalPolicy(platform, stdinIsTTY) {
  if (platform === 'win32') return { ignore: ['SIGINT', 'SIGHUP'], forward: [] };
  if (stdinIsTTY) return { ignore: ['SIGINT'], forward: ['SIGTERM', 'SIGHUP'] };
  return { ignore: [], forward: ['SIGINT', 'SIGTERM', 'SIGHUP'] };
}

/**
 * Run `execPath [execArgv] script ...args` as a child with inherited stdio, the same cwd and
 * the env plus the re-entry marker. Never resolves: the process exits with the child's code,
 * dies by the child's signal, or exits 1 when the child cannot be started.
 *
 * @param {object} [options] Overrides, for tests.
 * @param {string} [options.script] Script the child runs (default: this process's script).
 * @param {string[]} [options.args] Arguments for the script (default: this process's arguments).
 * @param {string} [options.execPath]
 * @param {string[]} [options.execArgv]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.cwd]
 * @param {boolean} [options.stdinIsTTY]
 * @param {string} [options.platform]
 * @returns {Promise<never>}
 */
export function relaunch(options = {}) {
  const {
    script = process.argv[1],
    args = process.argv.slice(2),
    execPath = process.execPath,
    execArgv = process.execArgv,
    env = process.env,
    cwd = process.cwd(),
    stdinIsTTY = isatty(0),
    platform = process.platform,
  } = options;

  // A debugger port is already taken by this process; replaying it would fail the child.
  const nodeArgs = execArgv.filter(arg => !arg.startsWith('--inspect'));

  const policy = signalPolicy(platform, stdinIsTTY);
  const handlers = [];
  const listen = (signal, handler) => {
    process.on(signal, handler);
    handlers.push([signal, handler]);
  };
  const removeHandlers = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.length = 0;
  };

  const child = spawn(execPath, [...nodeArgs, script, ...args], {
    stdio: 'inherit',
    cwd,
    env: { ...env, [RELAUNCH_MARKER]: '1' },
  });

  for (const signal of policy.ignore) listen(signal, () => {});
  for (const signal of policy.forward) {
    listen(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // The child is already gone; its exit event ends this process.
      }
    });
  }

  let spawned = false;
  child.once('spawn', () => {
    spawned = true;
  });

  child.once('error', error => {
    // After a successful spawn an error means a failed kill or message, not a dead child.
    if (spawned) return;
    removeHandlers();
    process.stderr.write(
      `CodeMie CLI was updated but the command could not be restarted (${error.message}); re-run the command.\n`
    );
    process.exit(1);
  });

  child.once('exit', (code, signal) => {
    removeHandlers();
    if (signal && platform !== 'win32') {
      // Re-raise with no handler left, so the parent dies the way the child did.
      process.kill(process.pid, signal);
      // A signal whose default action is not termination would return here; end explicitly.
      setTimeout(() => process.exit(1), 200);
      return;
    }
    process.exit(typeof code === 'number' ? code : 1);
  });

  return new Promise(() => {});
}
