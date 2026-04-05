import { promises as fs } from 'fs';
import { join } from 'path';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const BATCH_ROOT = '/tmp/openclaw/multi-message-mode/batch';

// Normalize identifier for filesystem use
const normalizeIdentifier = (identifier) => {
  return identifier.replace(/[^a-zA-Z0-9_.-]/g, '_');
};

// Get batch directory path for a given identifier
const getBatchDir = (identifier) => {
  const normalized = normalizeIdentifier(identifier);
  return join(BATCH_ROOT, normalized);
};

// Ensure batch directory exists
const ensureBatchDir = async (identifier) => {
  const dir = getBatchDir(identifier);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

// Check if batch mode is active
const isBatchActive = async (identifier) => {
  try {
    const dir = getBatchDir(identifier);
    await fs.access(join(dir, 'active'));
    return true;
  } catch {
    return false;
  }
};

// Activate batch mode
const activateBatch = async (identifier) => {
  const dir = await ensureBatchDir(identifier);
  await fs.writeFile(join(dir, 'active'), '');
  await fs.writeFile(join(dir, 'buffer.txt'), '');
  const meta = {
    activatedAt: new Date().toISOString(),
    identifier,
    messageCount: 0
  };
  await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
};

// Deactivate batch mode (keep buffer for reading)
const deactivateBatch = async (identifier) => {
  const dir = getBatchDir(identifier);
  try {
    await fs.unlink(join(dir, 'active'));
  } catch (err) {}
};

// Cancel batch mode (delete everything)
const cancelBatch = async (identifier) => {
  const dir = getBatchDir(identifier);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {}
};

// Append message to buffer
const appendToBuffer = async (identifier, message) => {
  const dir = getBatchDir(identifier);
  const bufferPath = join(dir, 'buffer.txt');
  const entry = `[${new Date().toISOString()}] ${message}\n---\n`;
  try {
    await fs.appendFile(bufferPath, entry);
    const metaPath = join(dir, 'meta.json');
    try {
      const metaContent = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(metaContent);
      meta.messageCount = (meta.messageCount || 0) + 1;
      meta.lastAppendedAt = new Date().toISOString();
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    } catch (err) {}
  } catch (err) {}
};

// Get identifier from sessionKey
// sessionKey format: "agent:main:telegram:group:-1003690577722:topic:1867"
// We want: "telegram:-1003690577722:topic:1867" (skip the chat type)
const getIdentifier = (ctx) => {
  if (ctx.sessionKey) {
    const match = ctx.sessionKey.match(/agent:\w+:(\w+):(?:group|user|channel):(.+)/);
    if (match) {
      return `${match[1]}:${match[2]}`;
    }
    // Fallback: try simpler pattern
    const fallback = ctx.sessionKey.match(/agent:\w+:(.+)/);
    if (fallback) {
      return fallback[1].replace(/:(group|user|channel):/, ':');
    }
  }
  return null;
};

export default definePluginEntry({
  id: 'multi-message-mode',
  name: 'Multi-Message Mode',
  description: 'Plugin for buffering multiple messages before processing',
  
  register(api) {
    api.logger.info('[multi-message-mode] Plugin registering');
    
    // ========================================
    // before_agent_reply hook
    // Handles: /mmm, /mmm-cancel, buffering, blocking
    // Lets /mmc pass through to before_prompt_build
    // ========================================
    api.on('before_agent_reply', async (event, ctx) => {
      api.logger.info('[multi-message-mode] before_agent_reply fired');
      const identifier = getIdentifier(ctx);
      
      if (!identifier) {
        return undefined;
      }
      
      const messageText = (event.cleanedBody || '').trim();

      // /mmm - Activate batch mode
      if (messageText === '/mmm') {
        api.logger.info(`[multi-message-mode] Activate command for ${identifier}`);
        const active = await isBatchActive(identifier);
        if (active) {
          return { handled: true, reply: { text: 'Multi-message mode already active.' } };
        }
        await activateBatch(identifier);
        return { handled: true, reply: { text: 'Multi-message mode activated. Send messages, then /mmc to release.' } };
      }
      
      // /mmm-cancel - Cancel batch mode
      if (messageText === '/mmm-cancel') {
        api.logger.info(`[multi-message-mode] Cancel command for ${identifier}`);
        const active = await isBatchActive(identifier);
        if (!active) {
          return { handled: true, reply: { text: 'No active multi-message batch.' } };
        }
        await cancelBatch(identifier);
        return { handled: true, reply: { text: 'Multi-message mode cancelled.' } };
      }
      
      // /mmc - Let through to before_prompt_build
      // before_prompt_build will inject the buffer content
      if (messageText === '/mmc') {
        const active = await isBatchActive(identifier);
        if (active) {
          api.logger.info(`[multi-message-mode] /mmc received, deactivating for ${identifier}`);
          await deactivateBatch(identifier);
        }
        return undefined; // Let through to before_prompt_build
      }
      
      // Message buffering (when batch is active)
      const active = await isBatchActive(identifier);
      if (!active) {
        return undefined; // Let agent process normally
      }
      
      // Batch is active - buffer transcript and cancel agent turn
      if (messageText) {
        let transcript = messageText;
        const transcriptMatch = messageText.match(/Transcript:\n(.+?)(?:\n---|$)/s);
        if (transcriptMatch) {
          transcript = transcriptMatch[1].trim();
        }
        await appendToBuffer(identifier, transcript);
        api.logger.info(`[multi-message-mode] Buffered ${transcript.length} chars for ${identifier}`);
      }
      
      return { handled: true, reply: { text: 'Message buffered.' } }; // Cancel agent turn and reply.
    }, { priority: 100 });
    
    // ========================================
    // before_prompt_build hook
    // Handles: /mmc - injects buffered content into LLM input
    // ========================================
    api.on('before_prompt_build', async (event, ctx) => {
      api.logger.info('[multi-message-mode] before_prompt_build fired');
      api.logger.info(`[multi-message-mode] before_prompt_build event keys: ${JSON.stringify(Object.keys(event))}`);
      api.logger.info(`[multi-message-mode] before_prompt_build ctx keys: ${JSON.stringify(Object.keys(ctx))}`);
      api.logger.info(`[multi-message-mode] before_prompt_build sessionKey: ${ctx.sessionKey}`);
      
      // Check if prompt contains /mmc
      const promptText = event.prompt || '';
      const hasMmc = promptText.includes('/mmc');
      api.logger.info(`[multi-message-mode] before_prompt_build hasMmc: ${hasMmc}`);
      
      if (!hasMmc) {
        return undefined;
      }
      
      const identifier = getIdentifier(ctx);
      api.logger.info(`[multi-message-mode] before_prompt_build identifier: ${identifier}`);
      
      if (!identifier) {
        api.logger.info('[multi-message-mode] before_prompt_build: no identifier');
        return undefined;
      }
      
      // Read the buffer
      const dir = getBatchDir(identifier);
      let bufferContent = '';
      try {
        bufferContent = await fs.readFile(join(dir, 'buffer.txt'), 'utf8');
      } catch (err) {}
      
      if (!bufferContent.trim()) {
        return { prependContext: 'The user released a multi-message batch, but no messages were buffered.' };
      }
      
      // Inject buffer content via prependContext
      api.logger.info(`[multi-message-mode] Injecting ${bufferContent.length} chars via prependContext`);
      return { 
        prependContext: `The user has collected the following messages via multi-message mode. Process them as a single request:\n---\n${bufferContent}---\n\n`
      };
    }, { priority: 100 });
    
    api.logger.info('[multi-message-mode] Plugin registered successfully');
  }
});
