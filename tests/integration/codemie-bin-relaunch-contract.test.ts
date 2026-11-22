/**
 * Structure contract for the post-update relaunch in bin/codemie.js.
 *
 * The relaunch must happen before anything can lazy-load from the files an update just
 * replaced, and the relay must keep working while dist/ is being replaced. Neither is
 * observable from a unit test, so the source is pinned: a refactor that reorders the
 * startup sequence or makes the relay import dist/ fails here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'bin');
const launcher = readFileSync(join(BIN_DIR, 'codemie.js'), 'utf-8');
const relay = readFileSync(join(BIN_DIR, 'relaunch.js'), 'utf-8');

/** Source with comments removed, so prose cannot satisfy or break a structural assertion. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('bin/relaunch.js', () => {
  it('imports only node: built-ins and never dist/', () => {
    const body = code(relay);
    const specifiers = [...body.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map(m => m[1]);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith('node:'), `non-builtin import: ${specifier}`).toBe(true);
    }
    expect(body).not.toContain('dist/');
    expect(body).not.toMatch(/\brequire\s*\(/);
  });
});

describe('bin/codemie.js relaunch wiring', () => {
  const body = code(launcher);
  const check = body.indexOf('await checkAndPromptForUpdate()');

  it('imports the relay statically', () => {
    expect(body).toMatch(/^import\s*\{[^}]*\brelaunch\b[^}]*\}\s*from\s*'\.\/relaunch\.js';/m);
    expect(body).toMatch(/^import\s*\{[^}]*\bconsumeRelaunchMarker\b[^}]*\}\s*from\s*'\.\/relaunch\.js';/m);
  });

  it('consumes the re-entry marker before the first dynamic import', () => {
    const consume = body.indexOf('consumeRelaunchMarker(');
    const firstDynamicImport = body.indexOf('import(');

    expect(consume).toBeGreaterThan(-1);
    expect(firstDynamicImport).toBeGreaterThan(-1);
    expect(consume).toBeLessThan(firstDynamicImport);
  });

  it('gates the update check on the marker so the relaunched child does not check again', () => {
    const gateStart = body.lastIndexOf('if (', check);

    expect(check).toBeGreaterThan(-1);
    expect(body.slice(gateStart, check)).toContain('!isRelaunched');
  });

  it('relaunches right after the install, before any further import', () => {
    const call = body.indexOf('relaunch(', check);

    expect(call).toBeGreaterThan(check);
    expect(body.slice(check, call)).not.toContain('import(');
  });

  it('relaunches the installed launcher with the original arguments', () => {
    const call = body.slice(body.indexOf('relaunch(', check));
    const args = call.slice(0, call.indexOf(');'));

    expect(args).toContain('fileURLToPath(import.meta.url)');
    expect(args).toContain('process.argv.slice(2)');
  });

  it('relaunches before the what\'s-new notice and the CLI entry', () => {
    const call = body.indexOf('relaunch(', check);

    expect(body.indexOf('whatsnew.js')).toBeGreaterThan(call);
    expect(body.indexOf('cli/index.js')).toBeGreaterThan(call);
  });
});
