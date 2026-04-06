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



// Extract transcript from voice message cleanedBody
// Format: "[Audio]\nUser text:\n... Transcript:\nMulti-message mode."
const extractTranscript = (cleanedBody) => {
  if (!cleanedBody.includes('<media:audio>') || !cleanedBody.includes('Transcript:')) {
    return null;
  }
  const match = cleanedBody.match(/Transcript:\n(.+?)(?:\n---|$)/s);
  return match ? match[1].trim() : null;
};

// Get transcript from event object (supports old embedded format and new fields)
const getTranscriptFromEvent = (event) => {
  // First try event.transcript
  if (event.transcript && typeof event.transcript === 'string') {
    return event.transcript.trim();
  }
  // Then try event.media?.transcript
  if (event.media && event.media.transcript && typeof event.media.transcript === 'string') {
    return event.media.transcript.trim();
  }
  // Fallback to old cleanedBody extraction
  const cleanedBody = event.cleanedBody || '';
  return extractTranscript(cleanedBody);
};

// Normalize text for keyword matching: lowercase, remove non-letter characters
const normalizeText = (text) => {
  return text.toLowerCase().replace(/[^a-z]/g, '');
};

// Check if event is an activation request (/mmm or voice "multi-message mode")
const isActivationRequest = (event) => {
  const cleanedBody = event.cleanedBody || '';
  const trimmed = cleanedBody.trim();
  if (trimmed === '/mmm') {
    return true;
  }
  const transcript = getTranscriptFromEvent(event);
  if (!transcript || transcript.length > 30) {
    return false; // Too long, treat as normal content
  }
  const normalized = normalizeText(transcript);
  return normalized === 'multimessagemode';
};

// Check if event is a deactivation request (/mmc or voice "multi-message complete")
const isDeactivationRequest = (event) => {
  const cleanedBody = event.cleanedBody || '';
  const trimmed = cleanedBody.trim();
  if (trimmed === '/mmc') {
    return true;
  }
  const transcript = getTranscriptFromEvent(event);
  if (!transcript || transcript.length > 30) {
    return false;
  }
  const normalized = normalizeText(transcript);
  return normalized === 'multimessagecomplete';
};

// Check if cleanedBody is a cancel request (/mmm-cancel)
const isCancelRequest = (cleanedBody) => {
  const trimmed = cleanedBody.trim();
  return trimmed === '/mmm-cancel';
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
    
    // Append message to buffer with error logging
    const appendToBuffer = async (identifier, message) => {
      const dir = getBatchDir(identifier);
      const bufferPath = join(dir, 'buffer.txt');
      const entry = `[${new Date().toISOString()}] ${message}\n---\n`;
      try {
        await fs.appendFile(bufferPath, entry);
      } catch (err) {
        api.logger.warn(`[multi-message-mode] Failed to append to buffer for ${identifier}: ${err.message}`);
        return; // Don't update meta if buffer write failed
      }
      
      // Update metadata
      const metaPath = join(dir, 'meta.json');
      try {
        const metaContent = await fs.readFile(metaPath, 'utf8');
        const meta = JSON.parse(metaContent);
        meta.messageCount = (meta.messageCount || 0) + 1;
        meta.lastAppendedAt = new Date().toISOString();
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
      } catch (err) {
        api.logger.warn(`[multi-message-mode] Failed to update metadata for ${identifier}: ${err.message}`);
        // Continue; buffer written, meta is secondary
      }
    };
    
    // ========================================
    // before_agent_reply hook
    // Handles: /mmm, /mmm-cancel, buffering, blocking
    // Lets /mmc pass through to before_prompt_build
    // ========================================
    api.on('before_agent_reply', async (event, ctx) => {
      const identifier = getIdentifier(ctx);
      api.logger.info(`[multi-message-mode] ctx keys: ${Object.keys(ctx).join(', ')}`);
      api.logger.info(`[multi-message-mode] ctx.sessionKey: ${ctx.sessionKey}`);
      // Log any media/transcript related fields in ctx
      if (ctx.media) {
        api.logger.info(`[multi-message-mode] ctx.media keys: ${Object.keys(ctx.media).join(', ')}`);
        if (ctx.media.transcript) api.logger.info(`[multi-message-mode] ctx.media.transcript: ${ctx.media.transcript}`);
      }
      if (ctx.transcript) api.logger.info(`[multi-message-mode] ctx.transcript: ${ctx.transcript}`);
      
      if (!identifier) {
        return undefined;
      }
      
      api.logger.info(`[multi-message-mode] event keys: ${Object.keys(event).join(', ')}`);
      // Log a safe subset of event (excluding large nested objects)
      const safeEvent = {};
      for (const key of Object.keys(event)) {
        const val = event[key];
        if (typeof val === 'string' && val.length < 500) {
          safeEvent[key] = val;
        } else if (typeof val === 'object' && val !== null) {
          safeEvent[key] = `[object ${val.constructor?.name || 'Object'}]`;
        } else {
          safeEvent[key] = typeof val;
        }
      }
      api.logger.info(`[multi-message-mode] event (safe): ${JSON.stringify(safeEvent)}`);
      // Log specific suspected fields
      const suspected = ['media', 'transcript', 'originalBody', 'raw', 'body', 'text'];
      for (const key of suspected) {
        if (key in event) {
          const val = event[key];
          if (typeof val === 'string') {
            api.logger.info(`[multi-message-mode] event.${key} (first 200): ${val.slice(0, 200).replace(/\n/g, '\\n')}`);
          } else if (typeof val === 'object' && val !== null) {
            api.logger.info(`[multi-message-mode] event.${key} keys: ${Object.keys(val).join(', ')}`);
            if (val.transcript && typeof val.transcript === 'string') {
              api.logger.info(`[multi-message-mode] event.${key}.transcript: ${val.transcript}`);
            }
          }
        }
      }
      const cleanedBody = event.cleanedBody || '';
      api.logger.info(`[multi-message-mode] cleanedBody (first 200 chars): ${cleanedBody.slice(0, 200).replace(/\n/g, '\\n')}`);
      const messageText = cleanedBody.trim();

      // Activation: /mmm or voice "multi-message mode"
      const transcript = getTranscriptFromEvent(event);
      api.logger.info(`[multi-message-mode] transcript: ${transcript}`);
      const normalized = normalizeText(transcript || '');
      api.logger.info(`[multi-message-mode] normalized: ${normalized}`);
      if (isActivationRequest(event)) {
        api.logger.info(`[multi-message-mode] Activate command for ${identifier}`);
        const active = await isBatchActive(identifier);
        if (active) {
          return { handled: true, reply: { text: 'Multi-message mode already active.' } };
        }
        await activateBatch(identifier);
        return { handled: true, reply: { text: 'Multi-message mode activated. Send messages, then /mmc to release.' } };
      }
      
      // Cancel: /mmm-cancel only (no voice equivalent)
      if (isCancelRequest(cleanedBody)) {
        api.logger.info(`[multi-message-mode] Cancel command for ${identifier}`);
        const active = await isBatchActive(identifier);
        if (!active) {
          return { handled: true, reply: { text: 'No active multi-message batch.' } };
        }
        await cancelBatch(identifier);
        return { handled: true, reply: { text: 'Multi-message mode cancelled.' } };
      }
      
      // Deactivation: /mmc or voice "multi-message complete"
      // Let through to before_prompt_build
      const transcript2 = getTranscriptFromEvent(event);
      api.logger.info(`[multi-message-mode] deactivation transcript: ${transcript2}`);
      const normalized2 = normalizeText(transcript2 || '');
      api.logger.info(`[multi-message-mode] deactivation normalized: ${normalized2}`);
      if (isDeactivationRequest(event)) {
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
        let content = messageText;
        // If it's a voice message, extract just the transcript
        const transcript = getTranscriptFromEvent(event);
        if (transcript !== null) {
          content = transcript;
        }
        await appendToBuffer(identifier, content);
      }
      
      return { handled: true, reply: { text: 'Message buffered.' } }; // Cancel agent turn and reply.
    }, { priority: 100 });
    
    // ========================================
    // before_prompt_build hook
    // Handles: /mmc - injects buffered content into LLM input
    // ========================================
    api.on('before_prompt_build', async (event, ctx) => {
      // Check if prompt is a deactivation request (/mmc or voice "multi-message complete")
      const promptText = event.prompt || '';
      const isDeactivation = promptText.includes('/mmc') || isDeactivationRequest(event);
      
      if (!isDeactivation) {
        return undefined;
      }
      
      const identifier = getIdentifier(ctx);
      
      if (!identifier) {
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

      // Clean up the batch directory (delete buffer files)
      try {
        await cancelBatch(identifier);
      } catch (err) {
        api.logger.warn(`[multi-message-mode] Failed to clean up batch for ${identifier}: ${err.message}`);
      }

      // Inject buffer content via prependContext
      api.logger.info(`[multi-message-mode] Injecting ${bufferContent.length} chars via prependContext`);
      return { 
        prependContext: `The user has collected the following messages via multi-message mode. Process them as a single request:\n---\n${bufferContent}---\n\n`
      };
    }, { priority: 100 });
  }
});
