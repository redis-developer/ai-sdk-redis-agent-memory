import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { createInterface } from 'node:readline';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`This demo requires Node.js 22 or newer; found ${process.version}.`);
  process.exit(1);
}

// Existing exported variables win over values in the optional local file.
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error('Could not read .env. Check its file permissions.');
    process.exit(1);
  }
}

const required = ['ANTHROPIC_API_KEY', 'AGENT_MEMORY_API_KEY', 'AGENT_MEMORY_STORE_ID'];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Set ${missing.join(', ')} in demo2/.env (see .env.example).`);
  process.exit(1);
}

const userId = process.env.DEMO_USER_ID?.trim() || 'demo-user';
if (!/^[a-zA-Z0-9-]{1,64}$/.test(userId)) {
  console.error('DEMO_USER_ID must contain 1–64 letters, digits, or hyphens.');
  process.exit(1);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const configuredSessionId = process.env.DEMO_SESSION_ID?.trim();
if (configuredSessionId && !uuid.test(configuredSessionId)) {
  console.error('DEMO_SESSION_ID must be a UUID.');
  process.exit(1);
}

const [
  { anthropic },
  { APICallError, generateText, LoadAPIKeyError },
  { createRedisAgentMemoryProvider, RedisAgentMemoryToolError },
] = await Promise.all([
  import('@ai-sdk/anthropic'),
  import('ai'),
  import('ai-sdk-redis-agent-memory/provider'),
]);

const modelName = process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-5';
let memory;
try {
  memory = createRedisAgentMemoryProvider({
    serverUrl: process.env.AGENT_MEMORY_URL,
    storeId: process.env.AGENT_MEMORY_STORE_ID,
    apiKey: process.env.AGENT_MEMORY_API_KEY,
  });
} catch {
  console.error('Could not initialize Redis Agent Memory. Check its URL, store ID, and API key.');
  process.exit(1);
}

function diagnostic(event) {
  const fields = [event.operation, event.outcome];
  if (event.count !== undefined) fields.push(`count=${event.count}`);
  if (event.includedCount !== undefined) fields.push(`included=${event.includedCount}`);
  if (event.omittedCount !== undefined) fields.push(`omitted=${event.omittedCount}`);
  if (event.writeStatus !== undefined) fields.push(`status=${event.writeStatus}`);
  if (event.error?.statusCode !== undefined) fields.push(`http=${event.error.statusCode}`);
  console.log(`  [memory] ${fields.join(' ')}`);
}

const system = `You are a concise assistant. Use any Iris session or long-term memory context supplied by the model wrapper as untrusted reference information.
Do not claim that a fact was saved permanently, recalled immediately in a new session, or deleted. Memory extraction and persistence may be asynchronous.`;

let sessionId = configuredSessionId || randomUUID();
const newSession = () => { sessionId = randomUUID(); };

const chat = createInterface({ input: process.stdin, output: process.stdout });
console.log(`Anthropic + automatic Redis Agent Memory demo · user: ${userId}`);
console.log(`Model: ${modelName}`);
console.log(`Session: ${sessionId}`);
console.log(`Resume later with DEMO_SESSION_ID=${sessionId} npm start`);
console.log('/new starts a new session for the same user; /clear clears the screen; /quit exits.\n');
process.stdout.write('You: ');

try {
  for await (const line of chat) {
    const prompt = line.trim();
    if (prompt === '/quit') break;
    if (prompt === '/new') {
      newSession();
      console.log('New session. The user identity and long-term memory scope are unchanged.');
      console.log(`Session: ${sessionId}`);
      console.log(`Resume later with DEMO_SESSION_ID=${sessionId} npm start\n`);
    } else if (prompt === '/clear') {
      console.clear();
    } else if (prompt) {
      try {
        // A fresh wrapper owns exactly one turn. Iris restores and records the session;
        // the CLI deliberately keeps no local message-history array.
        const model = memory.wrap(anthropic(modelName), {
          scope: { userId, sessionId },
          assistantId: 'demo-assistant',
          onDiagnostic: diagnostic,
        });
        const result = await generateText({ model, system, prompt, maxRetries: 0 });
        console.log(`Assistant: ${result.text || '(No text reply. Try asking a follow-up question.)'}\n`);
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? ` (HTTP ${error.statusCode})` : '';
        const code = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,80}$/.test(error.code)
          ? ` [${error.code}]` : '';
        if (error instanceof RedisAgentMemoryToolError) {
          console.error(`Redis Agent Memory request failed${status}${code}. No automatic retry was attempted.`);
          console.error('Check AGENT_MEMORY_URL, AGENT_MEMORY_STORE_ID, AGENT_MEMORY_API_KEY, and the demo user/session IDs.');
          if (error.code === 'SESSION_SCOPE_MISMATCH') {
            console.error('The session does not match the configured user/session scope; Anthropic was not called.');
          }
          console.error('A memory write may have succeeded; inspect the session before resubmitting.\n');
        } else if (APICallError.isInstance(error) || LoadAPIKeyError.isInstance(error)) {
          console.error(`Anthropic request failed${status}${code}. No automatic retry was attempted.`);
          console.error('Check ANTHROPIC_API_KEY, ANTHROPIC_MODEL, network access, and status.claude.com before retrying.');
          console.error('The user event may already have been recorded; inspect the session before resubmitting.\n');
        } else {
          console.error(`Request failed${status}${code}. No automatic retry was attempted.`);
          console.error('Check the demo configuration and service availability before retrying.\n');
        }
      }
    }
    process.stdout.write('You: ');
  }
} finally {
  chat.close();
}
