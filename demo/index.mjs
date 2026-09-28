import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

// Check before importing SDKs or calling Node APIs that older runtimes lack.
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`This demo requires Node.js 22 or newer; found ${process.version}.`);
  console.error('Run "nvm install 22" (if using nvm), then "npm start".');
  process.exit(1);
}

const [{ anthropic }, { ToolLoopAgent, isStepCount }, { RedisAgentMemory, instructions }] =
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
  console.error(`Set ${missing.join(', ')} in demo/.env (see .env.example).`);
  process.exit(1);
}

// Keep this identity stable so new conversations can recall the same user's memories.
const userId = process.env.DEMO_USER_ID ?? 'demo-user';
if (!/^[a-zA-Z0-9-]{1,64}$/.test(userId)) {
  console.error('DEMO_USER_ID must contain 1–64 letters, digits, or hyphens.');
  process.exit(1);
}

function logMemory(message, failed = false) {
  const output = failed ? process.stderr : process.stdout;
  const color = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0'
    && (output.isTTY || process.env.FORCE_COLOR !== undefined);
  output.write(`${color ? `\x1b[${failed ? 31 : 36}m` : ''}  [memory] ${message}${color ? '\x1b[0m' : ''}\n`);
}

function createConversation() {
  const sessionId = randomUUID();
  const memory = new RedisAgentMemory(
    process.env.AGENT_MEMORY_URL,
    process.env.AGENT_MEMORY_STORE_ID,
    process.env.AGENT_MEMORY_API_KEY,
    { userId, sessionId },
  );

  const agent = new ToolLoopAgent({
    model: anthropic(process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-5'),
    tools: memory,
    // onEnd records the turn; the model must not duplicate it.
    activeTools: ['get_memory_context', 'get_session_memory', 'create_memories', 'search_memories', 'update_memory'],
    instructions: `${instructions}
Current user and memory owner: ${userId}.
Current session: ${sessionId}. Current assistant actor: demo-assistant.
Keep replies concise. Use create_memories when asked to remember a fact, and
search_memories before answering questions about the user's preferences.
After each completed turn, onEnd records the user message and final assistant reply.
Do not call start_session or add_session_event; onEnd handles session writes.
Use get_session_memory for earlier completed turns; this turn isn't saved yet.
Deletion tools are unavailable. If asked to forget a fact, explain that
deletion is disabled; do not claim the fact was removed.
Only claim a fact was saved after checking the tool's created and errors fields.`,
    stopWhen: isStepCount(8),
    maxRetries: 0,
    include: { requestMessages: true },
    onEnd: async ({ steps, finalStep }) => {
      try {
        const userText = steps[0].request.messages.at(-1).content;
        for (const [role, text] of [['USER', userText], ['ASSISTANT', finalStep.text]]) {
          if (!text) continue;
          logMemory(`add_session_event (${role})`);
          await memory.add_session_event.execute({
            actorId: role === 'USER' ? userId : 'demo-assistant',
            role,
            content: [{ text }],
          }, { toolCallId: randomUUID(), messages: [] });
          logMemory(`${role} session event saved.`);
        }
      } catch {
        logMemory('Session save was not confirmed; the event may already be stored. Verify before retrying.', true);
      }
    },
    onToolExecutionStart: ({ toolCall }) => logMemory(toolCall.toolName),
    onToolExecutionEnd: ({ toolCall, toolOutput }) => {
      if (toolOutput.type === 'tool-error') {
        logMemory(`${toolCall.toolName} failed. Check your Redis configuration.`, true);
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

let conversation;
try {
  conversation = createConversation();
} catch {
  console.error('Invalid Redis configuration. Check AGENT_MEMORY_URL, AGENT_MEMORY_STORE_ID, and AGENT_MEMORY_API_KEY.');
  process.exit(1);
}

const chat = createInterface({ input: process.stdin, output: process.stdout });
console.log(`Redis Agent Memory demo · user: ${userId}`);
console.log(`Session: ${conversation.sessionId}`);
console.log('Try: Remember that I prefer TypeScript examples.');
console.log('Then /new, and ask: Which programming language do I prefer?');
console.log('/new starts a new session; saved sessions and memories remain. /quit exits.\n');
process.stdout.write('You: ');

try {
  for await (const line of chat) {
    const prompt = line.trim();
    if (prompt === '/quit') break;
    if (prompt === '/new') {
      conversation = createConversation();
      console.log('New conversation. Saved sessions and memories remain in Redis.');
      console.log(`Session: ${conversation.sessionId}\n`);
    } else if (prompt) {
      const turn = [...conversation.messages, { role: 'user', content: prompt }];
      try {
        const result = await conversation.agent.generate({ messages: turn });
        // Preserve all tool calls and results for subsequent turns in this chat.
        conversation.messages = [...turn, ...result.responseMessages];
        console.log(`Assistant: ${result.finalStep.text || '(No final text reply. Try asking a follow-up question.)'}\n`);
      } catch {
        // Do not replay a failed request: a memory write may already have landed.
        console.error('Request failed. Check your API keys, model, and Redis endpoint/store.');
        console.error('A memory write may have succeeded; ask the agent to recall it before retrying.\n');
      }
    }
    process.stdout.write('You: ');
  }
} finally {
  chat.close();
}
