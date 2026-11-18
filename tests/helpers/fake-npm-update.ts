import { spawn } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A throwaway copy of the built package plus a fake `npm`, to run the real `bin/codemie.js`
 * through a startup auto-update without a network or a real install.
 *
 * The fake `npm` answers `view <pkg> version` with a newer version, and on `install -g ... pkg@ver`
 * swaps files inside the copy while the CLI that asked for the install is still running. Two payloads:
 *
 * - `probe`: the update adds a new export to `dist/utils/processes.js` (already loaded by the running
 *   launcher) and makes `dist/cli/index.js` import it. This is the ticket's failure: without a relaunch
 *   the launcher's later `import('../dist/cli/index.js')` throws "does not provide an export named".
 * - `recorder`: the update replaces `bin/codemie.js` with a script that records how it was started.
 *
 * Needs `npm run build` first (the copy is made from `dist/`).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_TIMEOUT_MS = 90_000;

export const FAKE_NEW_VERSION = '99.0.0';

export type UpdatePayload = 'probe' | 'recorder';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RecordedStart {
  argv: string[];
  cwd: string;
  marker: string | null;
  scriptPath: string;
}

export interface FakeNpmUpdate {
  /** Root of the throwaway package copy. */
  readonly pkgDir: string;
  /** `bin/codemie.js` inside the copy. */
  readonly binPath: string;
  /** Fresh empty directory used as cwd by default. */
  readonly home: string;
  /** Restore the package copy and start from a fresh home, install count 0 and the given payload. */
  reset(payload: UpdatePayload): void;
  /** How many times the fake `npm` was asked to install. */
  installCount(): number;
  /** What the `recorder` payload wrote, or null when the replaced launcher never ran. */
  recorded(): RecordedStart | null;
  /** Run the copy's `bin/codemie.js` as a non-TTY process with the stripped environment. */
  run(args: string[], options?: { env?: Record<string, string>; cwd?: string }): Promise<RunResult>;
  cleanup(): void;
}

const FAKE_NPM = `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const pkg = process.env.FAKE_NPM_PKG;
const version = process.env.FAKE_NPM_VERSION;

if (args[0] === 'view') {
  console.log(version);
} else if (args[0] === 'prefix') {
  console.log(process.env.FAKE_NPM_PREFIX);
} else if (args[0] === 'config') {
  console.log(join(process.env.FAKE_NPM_PREFIX, '.npmrc'));
} else if (args[0] === 'install') {
  appendFileSync(process.env.FAKE_NPM_COUNT_FILE, 'x');
  const target = args[args.length - 1].split('@').pop();

  const manifestPath = join(pkg, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  manifest.version = target;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (process.env.FAKE_NPM_PAYLOAD === 'recorder') {
    writeFileSync(join(pkg, 'bin', 'codemie.js'), [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.env.FAKE_NPM_RECORD_FILE, JSON.stringify({',
      '  argv: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '  marker: process.env.CODEMIE_UPDATE_RELAUNCHED ?? null,',
      '  scriptPath: process.argv[1],',
      '}));',
      '',
    ].join('\\n'));
  } else {
    const processes = join(pkg, 'dist', 'utils', 'processes.js');
    writeFileSync(processes, readFileSync(processes, 'utf-8') + '\\nexport const relaunchProbe = true;\\n');

    const entry = join(pkg, 'dist', 'cli', 'index.js');
    const source = readFileSync(entry, 'utf-8');
    const probeImport = "import { relaunchProbe } from '../utils/processes.js';\\nvoid relaunchProbe;\\n";
    // A shebang has to stay on the first line
    writeFileSync(entry, source.startsWith('#!')
      ? source.replace(/^(#![^\\n]*\\n)/, '$1' + probeImport)
      : probeImport + source);
  }
} else {
  console.error('fake npm: unsupported command ' + args.join(' '));
  process.exit(1);
}
`;

/** Environment for a CLI start-up as a user's: no test flags, no inherited CODEMIE_* or npm config. */
function strippedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // lint-staged sets NO_COLOR; with vitest's FORCE_COLOR Node would warn on the child's stderr
  delete env.NO_COLOR;
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEMIE_') || key.startsWith('VITEST') || key.toLowerCase().startsWith('npm_config_')) {
      delete env[key];
    }
  }
  delete env.NODE_ENV;
  return env;
}

export function createFakeNpmUpdate(): FakeNpmUpdate {
  const root = mkdtempSync(join(tmpdir(), 'codemie-fake-update-'));
  const pkgDir = join(root, 'pkg');
  const binDir = join(root, 'fake-bin');
  const prefix = join(root, 'prefix');
  const countFile = join(root, 'install-count');
  const recordFile = join(root, 'recorded.json');

  mkdirSync(pkgDir);
  mkdirSync(binDir);
  mkdirSync(prefix);
  for (const entry of ['bin', 'dist', 'package.json']) {
    cpSync(join(REPO_ROOT, entry), join(pkgDir, entry), { recursive: true });
  }
  mkdirSync(join(pkgDir, 'src', 'utils'), { recursive: true });
  cpSync(join(REPO_ROOT, 'src', 'utils', 'tips.json'), join(pkgDir, 'src', 'utils', 'tips.json'));
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(pkgDir, 'node_modules'), 'junction');

  const fakeNpmScript = join(binDir, 'fake-npm.mjs');
  writeFileSync(fakeNpmScript, FAKE_NPM);
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'npm.cmd'), `@"${process.execPath}" "${fakeNpmScript}" %*\r\n`);
  } else {
    const shim = join(binDir, 'npm');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeNpmScript}" "$@"\n`);
    chmodSync(shim, 0o755);
  }

  // Files the fake install rewrites; restored by reset()
  const touched = ['package.json', join('bin', 'codemie.js'), join('dist', 'utils', 'processes.js'), join('dist', 'cli', 'index.js')];
  const pristine = new Map(touched.map(file => [file, readFileSync(join(pkgDir, file))]));

  let home = '';
  let payload: UpdatePayload = 'probe';

  function reset(next: UpdatePayload): void {
    for (const [file, content] of pristine) writeFileSync(join(pkgDir, file), content);
    rmSync(countFile, { force: true });
    rmSync(recordFile, { force: true });
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    home = mkdtempSync(join(root, 'home-'));
    payload = next;
  }

  function installCount(): number {
    return existsSync(countFile) ? readFileSync(countFile, 'utf-8').length : 0;
  }

  function recorded(): RecordedStart | null {
    return existsSync(recordFile) ? (JSON.parse(readFileSync(recordFile, 'utf-8')) as RecordedStart) : null;
  }

  function run(args: string[], options: { env?: Record<string, string>; cwd?: string } = {}): Promise<RunResult> {
    const env = strippedEnv();
    env.PATH = `${binDir}${delimiter}${env.PATH ?? env.Path ?? ''}`;
    if (process.platform === 'win32') env.Path = env.PATH;
    env.HOME = home;
    env.USERPROFILE = home;
    env.APPDATA = join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(home, 'AppData', 'Local');
    env.DO_NOT_TRACK = '1';
    env.npm_config_update_notifier = 'false';
    env.CODEMIE_HOME = home;
    env.FAKE_NPM_PKG = pkgDir;
    env.FAKE_NPM_VERSION = FAKE_NEW_VERSION;
    env.FAKE_NPM_PREFIX = prefix;
    env.FAKE_NPM_COUNT_FILE = countFile;
    env.FAKE_NPM_RECORD_FILE = recordFile;
    env.FAKE_NPM_PAYLOAD = payload;
    Object.assign(env, options.env);

    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [join(pkgDir, 'bin', 'codemie.js'), ...args], {
        cwd: options.cwd ?? home,
        env,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      child.stdin.end();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`codemie ${args.join(' ')} did not exit within ${RUN_TIMEOUT_MS}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
      }, RUN_TIMEOUT_MS);
      child.on('error', error => {
        clearTimeout(timer);
        fail(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        done({ code, signal, stdout, stderr });
      });
    });
  }

  function cleanup(): void {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  reset('probe');

  return {
    pkgDir,
    binPath: join(pkgDir, 'bin', 'codemie.js'),
    get home() {
      return home;
    },
    reset,
    installCount,
    recorded,
    run,
    cleanup,
  };
}
