/**
 * Startup auto-update relaunch - bin/codemie.js contract tests (EPMCDME-16837)
 *
 * A silent auto-update replaces the package files under the running launcher. Without a relaunch,
 * the process keeps modules loaded from the old files and its later lazy import of dist/cli/index.js
 * resolves against the new ones: "The requested module ... does not provide an export named ...".
 *
 * Runs the real bin/codemie.js from a throwaway copy of the built package, with a fake `npm` that
 * reports a newer version and rewrites the copy on install (see tests/helpers/fake-npm-update.ts).
 * Needs `npm run build` first.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeNpmUpdate, FAKE_NEW_VERSION, type FakeNpmUpdate, type RunResult } from '../helpers/fake-npm-update.js';

const MISSING_EXPORT = 'does not provide an export named';

function expectNoStaleModuleCrash(res: RunResult): void {
  expect(res.stderr).not.toContain(MISSING_EXPORT);
  expect(res.stdout).not.toContain(MISSING_EXPORT);
}

describe('startup auto-update relaunch', () => {
  let fixture: FakeNpmUpdate;

  beforeAll(() => {
    fixture = createFakeNpmUpdate();
  }, 120_000);

  afterAll(() => {
    fixture.cleanup();
  });

  describe('payload that adds an export to a module the launcher already loaded', () => {
    beforeEach(() => {
      fixture.reset('probe');
    });

    it('--version prints the updated version instead of crashing (AC3)', async () => {
      const res = await fixture.run(['--version']);

      expectNoStaleModuleCrash(res);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(FAKE_NEW_VERSION);
      expect(fixture.installCount()).toBe(1);
    });

    it.each([
      // doctor reports the health of the machine it runs on, so its exit code is 0 or 1 by design;
      // its own output is what proves the command ran on the updated install.
      { name: 'doctor', args: ['doctor'], codes: [0, 1], output: 'Frameworks' },
      { name: 'list', args: ['list'], codes: [0], output: 'codemie' },
      { name: 'analytics --help', args: ['analytics', '--help'], codes: [0], output: 'analytics' },
    ])('$name runs on the updated install (AC4)', async ({ args, codes, output }) => {
      const res = await fixture.run(args);

      expectNoStaleModuleCrash(res);
      expect(codes).toContain(res.code);
      expect(res.stdout.toLowerCase()).toContain(output.toLowerCase());
      expect(fixture.installCount()).toBe(1);
    });

    it('update exits 0 and installs once (AC4)', async () => {
      const res = await fixture.run(['update']);

      expectNoStaleModuleCrash(res);
      expect(res.code).toBe(0);
      expect(fixture.installCount()).toBe(1);
    });

    it('still installs once and runs the command when the check interval is 0 (AC6)', async () => {
      const res = await fixture.run(['--version'], { env: { CODEMIE_UPDATE_CHECK_INTERVAL: '0' } });

      expectNoStaleModuleCrash(res);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(FAKE_NEW_VERSION);
      expect(fixture.installCount()).toBe(1);
    });

    it('a process started with the re-entry marker does not check for an update', async () => {
      // Literal name on purpose: renaming the marker must fail this test
      const res = await fixture.run(['--version'], { env: { CODEMIE_UPDATE_RELAUNCHED: '1' } });

      expect(res.code).toBe(0);
      expect(fixture.installCount()).toBe(0);
    });
  });

  describe('payload that replaces the launcher with a recorder', () => {
    beforeEach(() => {
      fixture.reset('recorder');
    });

    it('relaunches the installed bin/codemie.js with the original args, cwd and the re-entry marker (AC8)', async () => {
      const cwd = mkdtempSync(join(fixture.home, 'cwd-'));
      const args = ['list', '--flag', 'two words'];

      const res = await fixture.run(args, { cwd });

      expect(res.code).toBe(0);
      expect(fixture.installCount()).toBe(1);
      const started = fixture.recorded();
      expect(started, 'the replaced launcher never ran').not.toBeNull();
      expect(started?.argv).toEqual(args);
      expect(realpathSync(started?.cwd as string)).toBe(realpathSync(cwd));
      // Literals, not the exported constant, so a rename fails the test
      expect(started?.marker).toBe('1');
      expect(realpathSync(started?.scriptPath as string)).toBe(realpathSync(fixture.binPath));
    });
  });
});
