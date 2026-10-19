import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.exports?.['./provider'], undefined, 'The superseded provider subpath must not be exported.');
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
  for (const path of [
    ...topLevelFiles,
    'dist/index.js', 'dist/index.d.ts', 'dist/provider.js', 'dist/provider.d.ts',
    'src/index.ts', 'src/provider.ts',
  ]) {
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
import * as packageExports from ${packageName};
import {
  createRedisAgentMemory, instructions, RedisAgentMemoryToolError,
} from ${packageName};

assert.equal(typeof createRedisAgentMemory, 'function');
assert.equal(packageExports.RedisAgentMemory, undefined);
assert.equal(packageExports.createRedisAgentMemoryTools, undefined);
assert.equal(packageExports.createRedisAgentMemoryProvider, undefined);
assert.equal(typeof instructions, 'string');
assert(instructions.length > 0);
assert(new RedisAgentMemoryToolError('TEST', 'Consumer verification') instanceof Error);

globalThis.fetch = async () => { throw new Error('Package verification must not call a memory server.'); };
const connection = {
  serverUrl: 'https://memory.example.invalid',
  storeId: 'package-test-store',
  apiKey: 'fake-package-verification-key',
};
const scope = { userId: 'package-test-user', sessionId: 'package-test-session' };
const configuredModel = {
  specificationVersion: 'v4',
  provider: 'package-verification',
  modelId: 'package-verification-model',
  supportedUrls: {},
  doGenerate: async () => { throw new Error('Package verification must not call the model.'); },
  doStream: async () => { throw new Error('Package verification must not call the model.'); },
};
const memory = createRedisAgentMemory({ ...connection, scope, model: configuredModel });
assert(Object.isFrozen(memory));
assert.deepEqual(Object.keys(memory), ['tools', 'model']);
const tools = memory.tools();
for (const name of ['get_memory_context', 'add_session_event', 'get_memory', 'search_memories', 'create_memories']) {
  assert.equal(typeof tools[name]?.execute, 'function', name + ' must be executable');
}
for (const name of ['delete_memories', 'delete_session_event', 'delete_session_memory',
  'list_namespaces', 'get_namespace', 'create_namespace', 'update_namespace', 'move_memories', 'delete_namespace']) {
  assert.equal(tools[name], undefined, name + ' must be disabled by default');
}
const enabled = createRedisAgentMemory({
  ...connection, scope, allowDeletes: true, namespaceTools: true,
}).tools();
assert.equal(typeof enabled.delete_memories?.execute, 'function');
assert.equal(typeof enabled.create_namespace?.execute, 'function');
assert.equal(typeof enabled.delete_namespace?.execute, 'function');
assert.equal(memory.model({ assistantId: 'assistant' }).specificationVersion, 'v4');
const toolsOnly = createRedisAgentMemory(connection);
assert.equal(typeof toolsOnly.tools().search_memories?.execute, 'function');
assert.throws(() => toolsOnly.model({
  scope, assistantId: 'assistant',
}), /model|configuration/i);
for (const model of [null, 'provider:model', {}]) {
  assert.throws(() => createRedisAgentMemory({ ...connection, model }), /model|configuration/i);
}
console.log('Verified installed ESM unified factory construction without network calls.');
`);
  run([join(consumer, 'runtime.mjs')]);

  writeFileSync(join(consumer, 'consumer.ts'), `
import { ToolLoopAgent, isStepCount, wrapLanguageModel, type ToolSet } from 'ai';
import {
  createRedisAgentMemory, instructions, RedisAgentMemoryToolError,
  type ConfiguredLanguageModel,
  type RedisAgentMemoryDiagnostic,
  type RedisAgentMemoryDiagnosticError,
  type RedisAgentMemoryLimits,
  type RedisAgentMemoryModelOptions,
  type RedisAgentMemoryOptions,
  type RedisAgentMemoryProvenance,
  type RedisAgentMemoryProvenanceEntry,
  type RedisAgentMemoryScope,
} from ${packageName};

type WrappedModel = Parameters<typeof wrapLanguageModel>[0]['model'];
declare const configuredModel: WrappedModel;
declare const otherModel: ConfiguredLanguageModel;
declare const optionalModel: ConfiguredLanguageModel | undefined;
const connection = {
  serverUrl: 'https://memory.example.invalid',
  storeId: 'package-test-store',
  apiKey: 'fake-package-verification-key',
};
const scope: RedisAgentMemoryScope = {
  userId: 'package-test-user',
  sessionId: 'package-test-session',
};
const factoryOptions: RedisAgentMemoryOptions<ConfiguredLanguageModel> = {
  ...connection, scope, model: configuredModel,
  allowDeletes: true, namespaceTools: true, timeoutMs: 5000,
};
// @ts-expect-error A definite default-model configuration must contain its model.
const missingDefiniteDefault: RedisAgentMemoryOptions<ConfiguredLanguageModel> = connection;
const limits: RedisAgentMemoryLimits = { memoryCount: 3, recordingChars: 10_000 };
const onDiagnostic = (event: RedisAgentMemoryDiagnostic): void => {
  const error: RedisAgentMemoryDiagnosticError | undefined = event.error;
  void error;
};
const modelOptions: RedisAgentMemoryModelOptions = {
  scope,
  assistantId: 'package-test-assistant',
  limits,
  includeMemoryProvenance: true,
  onDiagnostic,
};
const memory = createRedisAgentMemory(factoryOptions);
const tools: ToolSet = memory.tools();
const requestModel = memory.model(modelOptions);
const overridden = memory.model({ ...modelOptions, model: otherModel });
const agent = new ToolLoopAgent({ model: requestModel, tools, instructions, stopWhen: isStepCount(8) });
const toolsOnly = createRedisAgentMemory(connection);
toolsOnly.model({ ...modelOptions, model: configuredModel });
// @ts-expect-error A factory without a definite default requires a call-level configured model.
toolsOnly.model(modelOptions);
const optionalDefault = createRedisAgentMemory({ ...connection, model: optionalModel });
optionalDefault.model({ ...modelOptions, model: configuredModel });
// @ts-expect-error An optional default does not make the call-level model optional.
optionalDefault.model(modelOptions);
// @ts-expect-error Model-name strings are not configured model instances.
createRedisAgentMemory({ ...connection, model: 'provider:model' });
// @ts-expect-error Model-name strings are not configured model instances.
toolsOnly.model({ ...modelOptions, model: 'provider:model' });
// @ts-expect-error Malformed objects are not configured models.
createRedisAgentMemory({ ...connection, model: {} });
const provenanceEntry: RedisAgentMemoryProvenanceEntry = { id: 'memory-id' };
const provenance: RedisAgentMemoryProvenance = { memories: [provenanceEntry] };
const error: Error = new RedisAgentMemoryToolError('TEST', provenanceEntry.id);
void [agent, overridden, provenance, error, missingDefiniteDefault];
`);
  const compiler = join(consumer, 'node_modules', 'typescript', 'bin', 'tsc');
  const compilerArgs = [
    '--noEmit', '--strict', '--target', 'ES2022', '--lib', 'ES2022,DOM,DOM.Iterable',
    '--types', 'node', 'consumer.ts',
  ];
  run([compiler, ...compilerArgs, '--module', 'NodeNext', '--moduleResolution', 'NodeNext']);
  run([compiler, ...compilerArgs, '--module', 'ESNext', '--moduleResolution', 'Bundler']);
  console.log('Verified root declarations with NodeNext and Bundler.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
