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
  const providerPackageName = JSON.stringify(`${manifest.name}/provider`);
  writeFileSync(join(consumer, 'runtime.mjs'), `
import assert from 'node:assert/strict';
import {
  RedisAgentMemory, createRedisAgentMemoryTools, instructions, RedisAgentMemoryToolError,
} from ${packageName};

assert.equal(typeof RedisAgentMemory, 'function');
assert.equal(typeof createRedisAgentMemoryTools, 'function');
assert.equal(typeof instructions, 'string');
assert(instructions.length > 0);
assert(new RedisAgentMemoryToolError('TEST', 'Consumer verification') instanceof Error);

globalThis.fetch = async () => { throw new Error('Package verification must not call a memory server.'); };
const serverUrl = 'https://memory.example.invalid';
const storeId = 'package-test-store';
const apiKey = 'fake-package-verification-key';
const scope = { userId: 'package-test-user', sessionId: 'package-test-session' };
const tools = new RedisAgentMemory(serverUrl, storeId, apiKey, scope);
const plainTools = createRedisAgentMemoryTools(serverUrl, storeId, apiKey, scope);
assert.deepEqual(Object.keys(tools).sort(), Object.keys(plainTools).sort());
for (const name of ['get_memory_context', 'add_session_event', 'get_memory', 'search_memories', 'create_memories']) {
  assert.equal(typeof tools[name]?.execute, 'function', name + ' must be executable');
}
for (const name of ['delete_memories', 'delete_session_event', 'delete_session_memory',
  'list_namespaces', 'get_namespace', 'create_namespace', 'update_namespace', 'move_memories', 'delete_namespace']) {
  assert.equal(tools[name], undefined, name + ' must be disabled by default');
}
const enabledOptions = { allowDeletes: true, namespaceTools: true };
const enabled = createRedisAgentMemoryTools(serverUrl, storeId, apiKey, scope, enabledOptions);
const enabledClass = new RedisAgentMemory(serverUrl, storeId, apiKey, scope, enabledOptions);
assert.deepEqual(Object.keys(enabled).sort(), Object.keys(enabledClass).sort());
assert.equal(typeof enabled.delete_memories?.execute, 'function');
assert.equal(typeof enabled.create_namespace?.execute, 'function');
assert.equal(typeof enabled.delete_namespace?.execute, 'function');
console.log('Verified installed ESM exports and tool construction without network calls.');
`);
  run([join(consumer, 'runtime.mjs')]);

  writeFileSync(join(consumer, 'provider-runtime.mjs'), `
import assert from 'node:assert/strict';
import {
  createRedisAgentMemoryProvider, RedisAgentMemoryToolError,
} from ${providerPackageName};

globalThis.fetch = async () => { throw new Error('Package verification must not call a memory server.'); };
const model = {
  specificationVersion: 'v4',
  provider: 'package-verification',
  modelId: 'package-verification-model',
  supportedUrls: {},
  doGenerate: async () => { throw new Error('Package verification must not call the model.'); },
  doStream: async () => { throw new Error('Package verification must not call the model.'); },
};
const provider = createRedisAgentMemoryProvider({
  serverUrl: 'https://memory.example.invalid',
  storeId: 'package-test-store',
  apiKey: 'fake-package-verification-key',
  model,
});
assert(Object.isFrozen(provider));
assert.deepEqual(Object.keys(provider), ['forRequest']);
assert.equal(typeof provider.forRequest, 'function');
assert.equal(provider.wrap, undefined);
const requestModel = provider.forRequest({
  scope: { userId: 'package-test-user', sessionId: 'package-test-session' },
  assistantId: 'package-test-assistant',
});
assert.equal(requestModel.specificationVersion, 'v4');
assert.throws(() => createRedisAgentMemoryProvider({
  serverUrl: 'https://memory.example.invalid', storeId: 'package-test-store', apiKey: 'key',
}), /model|configuration/i);
assert.throws(() => createRedisAgentMemoryProvider({
  serverUrl: 'https://memory.example.invalid', storeId: 'package-test-store', apiKey: 'key', model: 'provider:model',
}), /model|configuration/i);
assert.throws(() => createRedisAgentMemoryProvider({
  serverUrl: 'https://memory.example.invalid', storeId: 'package-test-store', apiKey: 'key', model: {},
}), /model|configuration/i);
assert(new RedisAgentMemoryToolError('TEST', 'Consumer verification') instanceof Error);
console.log('Verified installed provider ESM request-model construction and invalid model rejection without network calls.');
`);
  run([join(consumer, 'provider-runtime.mjs')]);

  writeFileSync(join(consumer, 'consumer.ts'), `
import { ToolLoopAgent, isStepCount, type LanguageModel, type ToolSet } from 'ai';
import {
  RedisAgentMemory, createRedisAgentMemoryTools, instructions, RedisAgentMemoryToolError,
  type RedisAgentMemoryOptions, type RedisAgentMemoryScope,
} from ${packageName};

const serverUrl = 'https://memory.example.invalid';
const storeId = 'package-test-store';
const apiKey = 'fake-package-verification-key';
const scope: RedisAgentMemoryScope = { userId: 'package-test-user', sessionId: 'package-test-session' };
const options: RedisAgentMemoryOptions = { allowDeletes: true, namespaceTools: true, timeoutMs: 5000 };
const tools: ToolSet = new RedisAgentMemory(serverUrl, storeId, apiKey, scope, options);
const plainTools: ToolSet = createRedisAgentMemoryTools(serverUrl, storeId, apiKey, scope, options);
const memoryInstructions: string = instructions;
const error: Error = new RedisAgentMemoryToolError('TEST', memoryInstructions);
declare const model: LanguageModel;
const agent = new ToolLoopAgent({
  model, tools, instructions: memoryInstructions, stopWhen: isStepCount(8),
});
async function reply(): Promise<string> {
  const result = await agent.generate({ prompt: 'Recall my preferences.' });
  return result.finalStep.text;
}
void [tools, plainTools, error, reply];
`);
  writeFileSync(join(consumer, 'provider-consumer.ts'), `
import { ToolLoopAgent, isStepCount, wrapLanguageModel } from 'ai';
import {
  createRedisAgentMemoryProvider,
  RedisAgentMemoryToolError,
  type RedisAgentMemoryDiagnostic,
  type RedisAgentMemoryDiagnosticError,
  type RedisAgentMemoryLimits,
  type RedisAgentMemoryModelOptions,
  type RedisAgentMemoryProvider,
  type RedisAgentMemoryProviderOptions,
  type RedisAgentMemoryProvenance,
  type RedisAgentMemoryProvenanceEntry,
  type RedisAgentMemoryScope,
} from ${providerPackageName};

type ConfiguredModel = Parameters<typeof wrapLanguageModel>[0]['model'];
declare const configuredModel: ConfiguredModel;
declare const optionalModel: ConfiguredModel | undefined;
const connection: RedisAgentMemoryProviderOptions = {
  serverUrl: 'https://memory.example.invalid',
  storeId: 'package-test-store',
  apiKey: 'fake-package-verification-key',
  model: configuredModel,
};
const scope: RedisAgentMemoryScope = {
  userId: 'package-test-user',
  sessionId: 'package-test-session',
};
const limits: RedisAgentMemoryLimits = { memoryCount: 3, recordingChars: 10_000 };
const onDiagnostic = (event: RedisAgentMemoryDiagnostic): void => {
  const error: RedisAgentMemoryDiagnosticError | undefined = event.error;
  void error;
};
const options: RedisAgentMemoryModelOptions = {
  scope,
  assistantId: 'package-test-assistant',
  limits,
  includeMemoryProvenance: true,
  onDiagnostic,
};
const provider: RedisAgentMemoryProvider = createRedisAgentMemoryProvider(connection);
const requestModel: ReturnType<RedisAgentMemoryProvider['forRequest']> = provider.forRequest(options);
const agent = new ToolLoopAgent({ model: requestModel, stopWhen: isStepCount(8) });
// @ts-expect-error The configured model is required.
createRedisAgentMemoryProvider({ serverUrl: connection.serverUrl });
// @ts-expect-error Provider:model string IDs are not configured model instances.
createRedisAgentMemoryProvider({ ...connection, model: 'provider:model' });
// @ts-expect-error An optional configured model cannot satisfy the required model field.
createRedisAgentMemoryProvider({ ...connection, model: optionalModel });
// @ts-expect-error Malformed objects are not configured models.
createRedisAgentMemoryProvider({ ...connection, model: {} });
// @ts-expect-error The unreleased wrap API was removed rather than retained as an alias.
provider.wrap(configuredModel, options);
const provenanceEntry: RedisAgentMemoryProvenanceEntry = { id: 'memory-id' };
const provenance: RedisAgentMemoryProvenance = { memories: [provenanceEntry] };
const error: Error = new RedisAgentMemoryToolError('TEST', provenanceEntry.id);
void [requestModel, agent, provenance, error];
`);
  const compiler = join(consumer, 'node_modules', 'typescript', 'bin', 'tsc');
  const compilerArgs = [
    '--noEmit', '--strict', '--target', 'ES2022', '--lib', 'ES2022,DOM,DOM.Iterable',
    '--types', 'node', 'consumer.ts',
  ];
  run([compiler, ...compilerArgs, '--module', 'NodeNext', '--moduleResolution', 'NodeNext']);
  run([compiler, ...compilerArgs, '--module', 'ESNext', '--moduleResolution', 'Bundler']);
  for (const source of ['provider-consumer.ts']) {
    const args = compilerArgs.with(compilerArgs.length - 1, source);
    run([compiler, ...args, '--module', 'NodeNext', '--moduleResolution', 'NodeNext']);
    run([compiler, ...args, '--module', 'ESNext', '--moduleResolution', 'Bundler']);
  }
  console.log('Verified root and provider declarations with NodeNext and Bundler.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
