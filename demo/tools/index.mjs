import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { formatError, getErrorHelp } from './errors.mjs';

// Check before importing SDKs or calling Node APIs that older runtimes lack.
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`This demo requires Node.js 22 or newer; found ${process.version}.`);
  console.error('Run "nvm install 22" (if using nvm), then "npm start".');
  process.exit(1);
}

const [{ anthropic }, { ToolLoopAgent, isStepCount, APICallError, LoadAPIKeyError }, { createRedisAgentMemory, instructions, RedisAgentMemoryToolError }] =
  await Promise.all([
    import('@ai-sdk/anthropic'),
    import('ai'),
    import('ai-sdk-redis-agent-memory'),
  ]);

// Shell environment variables take precedence; a local .env file is optional.
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
if (missing.length) {
  console.error(`Set ${missing.join(', ')} in demo/tools/.env (see .env.example).`);
  process.exit(1);
}

// Keep this identity stable so new conversations can recall the same user's memories.
const userId = process.env.DEMO_USER_ID ?? 'demo-user';
if (!/^[a-zA-Z0-9-]{1,64}$/.test(userId)) {
  console.error('DEMO_USER_ID must contain 1–64 letters, digits, or hyphens.');
  process.exit(1);
}

const errorDetails = error => formatError(error, [
  process.env.ANTHROPIC_API_KEY, process.env.AGENT_MEMORY_API_KEY,
]);

function logMemory(message, failed = false) {
  const output = failed ? process.stderr : process.stdout;
  const color = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0'
    && (output.isTTY || process.env.FORCE_COLOR !== undefined);
  output.write(`${color ? `\x1b[${failed ? 31 : 36}m` : ''}  [memory] ${message}${color ? '\x1b[0m' : ''}\n`);
}

function logMemoryError(operation, error) {
  const help = getErrorHelp(error, 'Redis Agent Memory');
  logMemory(`${operation}: ${help.summary}`, true);
  logMemory(`Details: ${errorDetails(error)}`, true);
  logMemory(`Next: ${help.next}`, true);
}

function createConversation(memory) {
  const sessionId = randomUUID();
  const tools = memory.tools({ scope: { userId, sessionId } });
  const sessionObservers = {
    onEventStart: ({ role }) => logMemory(`add_session_event (${role})`),
    onEventSaved: ({ role }) => logMemory(`${role} session event saved.`),
    onError: (error, { role, phase }) => {
      logMemoryError(`${role} session save failed`, error);
      if (phase === 'write') {
        logMemory('Session save was not confirmed; the event may already be stored. Verify before retrying.', true);
      }
    },
  };

  const agent = new ToolLoopAgent({
    model: anthropic(process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-5'),
    tools,
    // Lifecycle hooks record the turn; the model must not duplicate it.
    activeTools: ['get_memory_context', 'get_session_memory', 'create_memories', 'search_memories', 'update_memory'],
    instructions: `${instructions}
Current user and memory owner: ${userId}.
Current session: ${sessionId}. Current assistant actor: demo-assistant.
Keep replies concise. Use create_memories when asked to remember a fact, and
search_memories before answering questions about the user's preferences.
onStart records the current user message; onEnd records the final assistant reply.
Do not call start_session or add_session_event; lifecycle hooks handle session writes.
Use get_session_memory for session history, including the current user message if its save succeeded.
Deletion tools are unavailable. If asked to forget a fact, explain that
deletion is disabled; do not claim the fact was removed.
Only claim a fact was saved after checking the tool's created and errors fields.`,
    stopWhen: isStepCount(8),
    maxRetries: 0,
    onStart: tools.createSessionEventHook({
      ...sessionObservers,
      role: 'USER',
      actorId: userId,
    }),
    onEnd: tools.createSessionEventHook({
      ...sessionObservers,
      role: 'ASSISTANT',
      actorId: 'demo-assistant',
    }),
    onToolExecutionStart: ({ toolCall }) => logMemory(toolCall.toolName),
    onToolExecutionEnd: ({ toolCall, toolOutput }) => {
      if (toolOutput.type === 'tool-error') {
        logMemoryError(`${toolCall.toolName} failed`, toolOutput.error);
      } else if (toolCall.toolName === 'create_memories') {
        const { created, errors } = toolOutput.output;
        logMemory(`${created.length} saved; ${errors?.length ?? 0} failed.`, Boolean(errors?.length));
      } else if (toolCall.toolName === 'search_memories') {
        logMemory(`${toolOutput.output.items.length} found.`);
      }
    },
  });
  return { sessionId, agent, messages: [] };
}

let memory;
let conversation;
try {
  memory = createRedisAgentMemory({
    serverUrl: process.env.AGENT_MEMORY_URL,
    storeId: process.env.AGENT_MEMORY_STORE_ID,
    apiKey: process.env.AGENT_MEMORY_API_KEY,
    scope: { userId },
  });
  conversation = createConversation(memory);
} catch (error) {
  console.error('Could not initialize the demo. Check the configuration details below.');
  console.error(`Details: ${errorDetails(error)}`);
  process.exit(1);
}

const chat = createInterface({ input: process.stdin, output: process.stdout });
console.log(`Redis Agent Memory demo · user: ${userId}`);
console.log(`Session: ${conversation.sessionId}`);
console.log('Try: Remember that I prefer TypeScript examples.');
console.log('Then /new, and ask: Which programming language do I prefer?');
console.log('/new starts a new session; saved sessions and memories remain.');
console.log('/clear clears the screen; /quit exits.\n');
process.stdout.write('You: ');

try {
  for await (const line of chat) {
    const prompt = line.trim();
    if (prompt === '/quit') break;
    if (prompt === '/new') {
      conversation = createConversation(memory);
      console.log('New conversation. Saved sessions and memories remain in Redis.');
      console.log(`Session: ${conversation.sessionId}\n`);
    } else if (prompt === '/clear') {
      console.clear();
    } else if (prompt) {
      const turn = [...conversation.messages, { role: 'user', content: prompt }];
      try {
        const result = await conversation.agent.generate({ messages: turn });
        // Preserve all tool calls and results for subsequent turns in this chat.
        conversation.messages = [...turn, ...result.responseMessages];
        console.log(`Assistant: ${result.finalStep.text || '(No final text reply. Try asking a follow-up question.)'}\n`);
      } catch (error) {
        // Do not replay a failed request: a memory write may already have landed.
        const service = error instanceof RedisAgentMemoryToolError ? 'Redis Agent Memory'
          : APICallError.isInstance(error) || LoadAPIKeyError.isInstance(error) ? 'Anthropic' : undefined;
        const help = getErrorHelp(error, service);
        console.error(`Request failed: ${help.summary}`);
        console.error(`Details: ${errorDetails(error)}`);
        console.error(`Next: ${help.next}`);
        console.error('A memory write may have succeeded. Check the saved session before resubmitting; this turn was not retried.\n');
      }
    }
    process.stdout.write('You: ');
  }
} finally {
  chat.close();
}
