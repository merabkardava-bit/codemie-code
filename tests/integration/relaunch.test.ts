/**
 * bin/relaunch.js - relay used by bin/codemie.js after a startup auto-update
 *
 * `relaunch()` never resolves (it exits the process), so every case drives it through a throwaway
 * driver script and, where the child matters, a small child script. The module under test is
 * the real file; nothing is mocked.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELAUNCH_URL = pathToFileURL(join(REPO_ROOT, 'bin', 'relaunch.js')).href;
const RUN_TIMEOUT_MS = 20_000;
const isWindows = process.platform === 'win32'; // signal semantics below are POSIX-only

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const DRIVER = `
import { readFileSync } from 'node:fs';
import { relaunch, consumeRelaunchMarker } from ${JSON.stringify(RELAUNCH_URL)};
const options = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
if (options.mode === 'consume') {
  const consumed = consumeRelaunchMarker();
  console.log(JSON.stringify({ consumed, after: process.env.CODEMIE_UPDATE_RELAUNCHED ?? null }));
} else {
  await relaunch(options);
}
`;

const CHILD = `
import { writeFileSync, appendFileSync } from 'node:fs';
const [mode, arg, extra] = process.argv.slice(2);
if (mode === 'exit') {
  process.exit(Number(arg));
} else if (mode === 'dump') {
  writeFileSync(arg, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    marker: process.env.CODEMIE_UPDATE_RELAUNCHED ?? null,
    probe: process.env.RELAUNCH_PROBE ?? null,
    execArgv: process.execArgv,
  }));
} else if (mode === 'selfkill') {
  process.kill(process.pid, arg);
  setTimeout(() => {}, 10000);
} else if (mode === 'count-sigint') {
  process.on('SIGINT', () => {
    appendFileSync(arg, 'x');
    setTimeout(() => process.exit(0), 500);
  });
  writeFileSync(extra, 'ready');
  setTimeout(() => process.exit(3), 15000);
}
`;

describe('bin/relaunch.js', () => {
  let dir: string;
  let driverPath: string;
  let childPath: string;
  let counter = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemie-relaunch-'));
    driverPath = join(dir, 'driver.mjs');
    childPath = join(dir, 'child.mjs');
    writeFileSync(driverPath, DRIVER);
    writeFileSync(childPath, CHILD);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function scratch(name: string): string {
    return join(dir, `${++counter}-${name}`);
  }

  function driverEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
    delete env.NODE_ENV;
    for (const key of Object.keys(env)) {
      if (key.startsWith('VITEST') || key.startsWith('CODEMIE_')) delete env[key];
    }
    return Object.assign(env, extra);
  }

  function writeOptions(options: Record<string, unknown>): string {
    const file = scratch('options.json');
    writeFileSync(file, JSON.stringify(options));
    return file;
  }

  function runDriver(options: Record<string, unknown>, extraEnv: Record<string, string> = {}, cwd = dir): Promise<RunResult> {
    const optionsFile = writeOptions(options);
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [driverPath, optionsFile], { cwd, env: driverEnv(extraEnv), windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`driver did not exit within ${RUN_TIMEOUT_MS}ms\nstderr: ${stderr}`));
      }, RUN_TIMEOUT_MS);
      child.on('error', fail);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        done({ code, signal, stdout, stderr });
      });
    });
  }

  it('passes the child exit code 0 through', async () => {
    const res = await runDriver({ script: childPath, args: ['exit', '0'] });
    expect(res.code).toBe(0);
  });

  it('passes a non-zero child exit code through', async () => {
    const res = await runDriver({ script: childPath, args: ['exit', '7'] });
    expect(res.code).toBe(7);
  });

  it('hands argv, cwd and the re-entry marker to the child and keeps the rest of the env', async () => {
    const out = scratch('dump.json');
    const cwd = mkdtempSync(join(dir, 'cwd-'));
    const res = await runDriver({ script: childPath, args: ['dump', out, '--flag', 'two words'] }, { RELAUNCH_PROBE: 'kept' }, cwd);

    expect(res.code).toBe(0);
    const seen = JSON.parse(readFileSync(out, 'utf-8'));
    expect(seen.argv).toEqual(['dump', out, '--flag', 'two words']);
    expect(seen.cwd.toLowerCase()).toBe(cwd.toLowerCase());
    expect(seen.marker).toBe('1');
    expect(seen.probe).toBe('kept');
  });

  it('does not replay --inspect flags from execArgv but keeps the others', async () => {
    const out = scratch('dump.json');
    const res = await runDriver({
      script: childPath,
      args: ['dump', out],
      execArgv: ['--inspect=0', '--inspect-brk', '--no-warnings'],
    });

    expect(res.code).toBe(0);
    const seen = JSON.parse(readFileSync(out, 'utf-8'));
    expect(seen.execArgv).toEqual(['--no-warnings']);
  });

  it('consumeRelaunchMarker reports and deletes the marker', async () => {
    const withMarker = await runDriver({ mode: 'consume' }, { CODEMIE_UPDATE_RELAUNCHED: '1' });
    expect(JSON.parse(withMarker.stdout)).toEqual({ consumed: true, after: null });

    const without = await runDriver({ mode: 'consume' });
    expect(JSON.parse(without.stdout)).toEqual({ consumed: false, after: null });
  });

  it('reports a spawn failure in one stderr line and exits 1 without falling through', async () => {
    const res = await runDriver({
      script: childPath,
      args: ['exit', '0'],
      execPath: join(dir, 'no-such-node-binary'),
    });

    expect(res.code).toBe(1);
    const lines = res.stderr.split(/\r?\n/).filter(line => line.trim() !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/updated/i);
    expect(lines[0]).toMatch(/re-?run/i);
    expect(res.stdout).toBe('');
  });

  it.skipIf(isWindows)('dies by the same signal when the child is killed by one', async () => {
    const res = await runDriver({ script: childPath, args: ['selfkill', 'SIGTERM'] });
    expect(res.signal).toBe('SIGTERM');
  });

  // AC8: one Ctrl+C reaches the child once, not twice. A terminal sends SIGINT to the whole
  // foreground process group, so the parent must neither die from it nor forward it again.
  it.skipIf(isWindows)('delivers a group-wide SIGINT to the child exactly once (TTY stdin)', async () => {
    const countFile = scratch('sigint-count');
    const readyFile = scratch('ready');
    const optionsFile = writeOptions({
      script: childPath,
      args: ['count-sigint', countFile, readyFile],
      stdinIsTTY: true,
    });

    const driver = spawn(process.execPath, [driverPath, optionsFile], {
      cwd: dir,
      env: driverEnv(),
      detached: true,
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>(done => driver.on('close', code => done(code)));

    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (!existsSync(readyFile) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(existsSync(readyFile)).toBe(true);

    process.kill(-(driver.pid as number), 'SIGINT');
    const code = await exited;

    expect(code).toBe(0);
    expect(readFileSync(countFile, 'utf-8')).toBe('x');
  });
});
