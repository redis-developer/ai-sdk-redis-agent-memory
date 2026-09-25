import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this check through npm run check:package so npm_execpath is available.');

const requireFromPackage = createRequire(join(root, 'package.json'));
const dependencies = ['ai', 'zod', 'typescript', '@types/node'].map((name) => {
  let version;
  try {
    const installedManifest = requireFromPackage.resolve(`${name}/package.json`);
    version = JSON.parse(readFileSync(installedManifest, 'utf8')).version;
  } catch {
    version = manifest.devDependencies?.[name];
  }
  assert(version, `Missing development dependency for consumer verification: ${name}`);
  return `${name}@${version}`;
});

const temporary = mkdtempSync(join(tmpdir(), 'redis-agent-memory-package-'));
const consumer = join(temporary, 'consumer');
const run = (args, cwd = consumer) => execFileSync(process.execPath, args, {
  cwd,
  stdio: 'inherit',
});

try {
  const packed = JSON.parse(execFileSync(process.execPath, [
    npmCli, 'pack', '--silent', '--ignore-scripts', '--json', '--pack-destination', temporary,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  assert.equal(packed.length, 1, 'Expected exactly one npm package.');
  const [artifact] = packed;
  assert.equal(artifact.name, manifest.name, 'Packed the wrong package.');
  assert.equal(artifact.filename, basename(artifact.filename), 'Unexpected tarball filename.');

  const files = new Set(artifact.files.map(({ path }) => path));
  const topLevelFiles = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
  for (const path of files) {
    assert(!path.split('/').includes('..'), `Invalid package path: ${path}`);
    assert(
      topLevelFiles.has(path) || path.startsWith('dist/') || path.startsWith('src/'),
      `Unexpected published file: ${path}`,
    );
  }
  for (const path of [...topLevelFiles, 'dist/index.js', 'dist/index.d.ts', 'src/index.ts']) {
    assert(files.has(path), `Required published file is missing: ${path}`);
  }
  console.log(`Verified tarball contents (${files.size} files).`);

  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'redis-agent-memory-package-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
  }, null, 2));
  run([
    npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    '--cache', join(temporary, 'npm-cache'),
    join(temporary, artifact.filename), ...dependencies,
  ]);

  const packageName = JSON.stringify(manifest.name);
  writeFileSync(join(consumer, 'runtime.mjs'), `
import assert from 'node:assert/strict';
import {
  RedisAgentMemory, createIrisMemoryTools, irisMemoryInstructions, IrisToolError,
} from ${packageName};

assert.equal(typeof RedisAgentMemory, 'function');
assert.equal(typeof createIrisMemoryTools, 'function');
assert.equal(typeof irisMemoryInstructions, 'string');
assert(irisMemoryInstructions.length > 0);
assert(new IrisToolError('TEST', 'Consumer verification') instanceof Error);

const options = {
  storeId: 'package-test-store',
  serverURL: 'https://memory.example.invalid',
  scope: { ownerId: 'package-test-user', sessionId: 'package-test-session' },
  allowDeletes: false,
  fetch: async () => { throw new Error('Package verification must not call a memory server.'); },
};
const tools = new RedisAgentMemory('fake-package-verification-key', options);
const plainTools = createIrisMemoryTools('fake-package-verification-key', options);
assert.deepEqual(Object.keys(tools).sort(), Object.keys(plainTools).sort());
for (const name of ['get_memory_context', 'add_session_event', 'get_memory', 'search_memories', 'create_memories']) {
  assert.equal(typeof tools[name]?.execute, 'function', name + ' must be executable');
}
assert.equal(tools.delete_memories, undefined);
console.log('Verified installed ESM exports and tool construction without network calls.');
`);
  run([join(consumer, 'runtime.mjs')]);

  writeFileSync(join(consumer, 'consumer.ts'), `
import { ToolLoopAgent, isStepCount, type LanguageModel, type ToolSet } from 'ai';
import {
  RedisAgentMemory, createIrisMemoryTools, irisMemoryInstructions, IrisToolError,
} from ${packageName};

const options = {
  storeId: 'package-test-store',
  serverURL: 'https://memory.example.invalid',
  scope: { ownerId: 'package-test-user', sessionId: 'package-test-session' },
  allowDeletes: false,
};
const tools: ToolSet = new RedisAgentMemory('fake-package-verification-key', options);
const plainTools: ToolSet = createIrisMemoryTools('fake-package-verification-key', options);
const instructions: string = irisMemoryInstructions;
const error: Error = new IrisToolError('TEST', instructions);
declare const model: LanguageModel;
const agent = new ToolLoopAgent({
  model, tools, instructions, stopWhen: isStepCount(8),
});
async function reply(): Promise<string> {
  const result = await agent.generate({ prompt: 'Recall my preferences.' });
  return result.finalStep.text;
}
void [tools, plainTools, error, reply];
`);
  const compiler = join(consumer, 'node_modules', 'typescript', 'bin', 'tsc');
  const compilerArgs = [
    '--noEmit', '--strict', '--target', 'ES2022', '--lib', 'ES2022,DOM,DOM.Iterable',
    '--types', 'node', 'consumer.ts',
  ];
  run([compiler, ...compilerArgs, '--module', 'NodeNext', '--moduleResolution', 'NodeNext']);
  run([compiler, ...compilerArgs, '--module', 'ESNext', '--moduleResolution', 'Bundler']);
  console.log('Verified installed declarations and ToolSet compatibility with NodeNext and Bundler.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
