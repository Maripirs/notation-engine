// Packaging smoke test: what a stranger gets from `npm install notation-engine`.
//
// Builds, checks that `npm pack` would publish only the built files plus the
// license, readme and manifest, then packs the tarball into a temp dir,
// installs it into a scratch ESM project there and, with plain Node, imports
// every documented entry point and checks its key exports. Node has no DOM, so
// the import itself doubles as the check that nothing touches one at module
// load (SSR hosts import the package on the server). Finally a consumer
// TypeScript file is type-checked against the installed declarations with
// `skipLibCheck` off, so a broken `.d.ts` fails here rather than in a user's
// editor.
//
// Run with `npm run smoke`. Needs network access only if npm decides it does
// (the package has no runtime dependencies, so normally it does not).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Paths `npm pack` may publish; anything else (sources, tests, assets) fails. */
const ALLOWED = [/^dist\//, /^LICENSE$/, /^README\.md$/, /^package\.json$/];

function run(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', ...options });
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args.join(' ')} failed (${result.status}):\n${result.stdout ?? ''}${result.stderr ?? ''}`);
	}
	return result.stdout ?? '';
}

function step(message) {
	console.log(`\n> ${message}`);
}

function kb(bytes) {
	return `${(bytes / 1024).toFixed(1)} kB`;
}

step('npm run build');
run(npm, ['run', 'build'], { stdio: 'inherit' });

step('npm pack --dry-run: published file list');
const [dryRun] = JSON.parse(run(npm, ['pack', '--dry-run', '--json']));
const width = Math.max(...dryRun.files.map((f) => f.path.length));
for (const file of dryRun.files) console.log(`  ${file.path.padEnd(width)}  ${kb(file.size).padStart(9)}`);
console.log(`  ${dryRun.files.length} files, ${kb(dryRun.size)} packed, ${kb(dryRun.unpackedSize)} unpacked`);
const stray = dryRun.files.map((f) => f.path).filter((path) => !ALLOWED.some((re) => re.test(path)));
if (stray.length > 0) throw new Error(`npm pack would publish files outside dist/, LICENSE, README.md, package.json:\n  ${stray.join('\n  ')}`);

const scratch = mkdtempSync(join(tmpdir(), 'notation-engine-smoke-'));
try {
	step(`npm pack into ${scratch}`);
	const [packed] = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', scratch]));
	const tarball = join(scratch, packed.filename);

	step('install the tarball into a scratch ESM project');
	writeFileSync(
		join(scratch, 'package.json'),
		JSON.stringify({ name: 'notation-engine-smoke', private: true, type: 'module' }, null, '\t')
	);
	run(npm, ['install', tarball, '--no-audit', '--no-fund', '--no-package-lock'], { cwd: scratch });

	step('import every entry point with plain Node');
	writeFileSync(
		join(scratch, 'check.mjs'),
		`import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as engine from 'notation-engine';
import * as examples from 'notation-engine/examples';
import manifest from 'notation-engine/package.json' with { type: 'json' };

for (const name of ['mountScore', 'importMusicXml', 'exportMusicXml', 'layoutScore', 'loadSmuflFont']) {
	assert.equal(typeof engine[name], 'function', name);
}
for (const name of ['CanvasRenderer', 'PlaybackEngine', 'Score', 'EditHistory']) {
	assert.equal(typeof engine[name], 'function', name);
}
assert.equal(engine.NOTATION_ENGINE_VERSION, ${JSON.stringify(pkg.version)}, 'NOTATION_ENGINE_VERSION');
assert.equal(manifest.version, ${JSON.stringify(pkg.version)}, 'package.json export');

assert.ok(engine.bravuraFontUrl instanceof URL, 'bravuraFontUrl is a URL');
const fontPath = realpathSync(fileURLToPath(engine.bravuraFontUrl));
const packageDir = realpathSync(fileURLToPath(new URL('./node_modules/notation-engine/', import.meta.url)));
assert.ok(fontPath.startsWith(packageDir), \`bravuraFontUrl inside the package: \${fontPath}\`);
assert.ok(existsSync(fontPath), \`bravuraFontUrl exists: \${fontPath}\`);

for (const name of ['createDemoScore', 'createFullDemoScore', 'createGrandStaffShowcaseScore']) {
	assert.equal(typeof examples[name], 'function', name);
}
assert.equal('createDemoScore' in engine, false, 'showcase scores stay out of the main entry');

// End to end without a DOM: a showcase score through layout and MusicXML.
const score = examples.createFullDemoScore();
assert.ok(engine.layoutScore(score).measures.length > 0, 'layout');
const xml = engine.exportMusicXml(score);
assert.ok(engine.importMusicXml(xml).staves.length > 0, 'MusicXML round trip');

console.log(\`  notation-engine \${engine.NOTATION_ENGINE_VERSION}: \${Object.keys(engine).length} exports, examples: \${Object.keys(examples).length}\`);
console.log(\`  bravuraFontUrl -> \${fontPath.slice(packageDir.length)}\`);
`
	);
	process.stdout.write(run(process.execPath, ['check.mjs'], { cwd: scratch }));

	step('type-check a consumer against the installed declarations');
	writeFileSync(
		join(scratch, 'consumer.ts'),
		`import { mountScore, importMusicXml, NOTATION_ENGINE_VERSION, type ScoreView } from 'notation-engine';
import { createDemoScore } from 'notation-engine/examples';

export const version: string = NOTATION_ENGINE_VERSION;

export function embed(host: HTMLElement, xml?: string): Promise<ScoreView> {
	return mountScore(host, xml === undefined ? createDemoScore() : importMusicXml(xml));
}
`
	);
	writeFileSync(
		join(scratch, 'tsconfig.json'),
		JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2022',
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					lib: ['ES2022', 'DOM', 'DOM.Iterable'],
					types: [],
					strict: true,
					skipLibCheck: false,
					noEmit: true
				},
				files: ['consumer.ts']
			},
			null,
			'\t'
		)
	);
	run(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', scratch], { cwd: scratch });
	console.log('  consumer.ts type-checks (NodeNext resolution, skipLibCheck off)');
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log('\nsmoke: ok');
