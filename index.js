import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { transcribeFirstAudio } from 'openclaw/plugin-sdk/media-runtime';

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





// Normalize text for keyword matching: lowercase, remove non-letter characters
const normalizeText = (text) => {
  return text.toLowerCase().replace(/[^a-z]/g, '');
};



// Check if cleanedBody is a cancel request (/mmm-cancel)
const isCancelRequest = (cleanedBody, cfg = {}) => {
  const slashCommands = cfg?.slashCommands ?? {};
  const mmmCancelSlash = slashCommands.mmmCancel ?? '/mmm-cancel';
  const trimmed = cleanedBody.trim();
  return trimmed === mmmCancelSlash;
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
    
    api.logger.info(`[multi-message-mode] config: ${JSON.stringify(api.pluginConfig, null, 2)}`);
    // Check if cleanedBody is an activation request (/mmm or voice "multi-message mode")
    const isActivationRequest = (cleanedBody, cfg = {}) => {
      api.logger.info(`[multi-message-mode] cfg: ${JSON.stringify(cfg, null, 2)}`);
      const slashCommands = cfg?.slashCommands ?? {};
      const voiceKeywords = cfg?.voiceKeywords ?? {};
      const mmmSlash = slashCommands.mmm ?? '/mmm';
      const voiceActivate = voiceKeywords.activate ?? 'multi-message mode';
      const trimmed = cleanedBody.trim();
      if (trimmed === mmmSlash) {
        return true;
      }
      const transcript = extractTranscript(cleanedBody);
      if (!transcript || transcript.length > 30) {
        return false; // Too long, treat as normal content
      }
      const normalized = normalizeText(transcript);
      const normalizedKeyword = normalizeText(voiceActivate);
      api.logger.info(`[multi-message-mode] normalized: ${normalized}`);
      api.logger.info(`[multi-message-mode] normalizedKeyword: ${normalizedKeyword}`);
      return normalized === normalizedKeyword;
    };
    
    // Check if cleanedBody is a deactivation request (/mmc or voice "multi-message complete")
    const isDeactivationRequest = (cleanedBody, cfg = {}) => {
      const slashCommands = cfg?.slashCommands ?? {};
      const voiceKeywords = cfg?.voiceKeywords ?? {};
      const mmcSlash = slashCommands.mmc ?? '/mmc';
      const voiceDeactivate = voiceKeywords.deactivate ?? 'multi-message complete';
      const trimmed = cleanedBody.trim();
      if (trimmed === mmcSlash) {
        return true;
      }
      const transcript = extractTranscript(cleanedBody);
      if (!transcript || transcript.length > 30) {
        return false;
      }
      const normalized = normalizeText(transcript);
      const normalizedKeyword = normalizeText(voiceDeactivate);
      return normalized === normalizedKeyword;
    };
    
    
    // Extract transcript from voice message cleanedBody
    // Format: "[Audio]\nUser text:\n... Transcript:\nMulti-message mode."
    const extractTranscript = (cleanedBody) => {
      api.logger.info(`[multi-message-mode] cleanedBody: ${cleanedBody}`);
      const isAudio = cleanedBody.includes('<media:audio>') || cleanedBody.includes('[Audio]');
      if (!isAudio || !cleanedBody.includes('Transcript:')) {
        return null;
      }
      const match = cleanedBody.match(/Transcript:\n(.+?)(?:\n---|$)/s);
      return match ? match[1].trim() : null;
    };
    
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
      api.logger.info(`[multi-message-mode] before_agent_reply event: ${JSON.stringify(event, null, 2)}`)
      api.logger.info(`[multi-message-mode] before_agent_reply ctx: ${JSON.stringify(ctx, null, 2)}`)
      const identifier = getIdentifier(ctx);

      const slashCommands = ctx.cfg?.slashCommands ?? {};

      const mmmSlash = slashCommands.mmm ?? '/mmm';

      const mmcSlash = slashCommands.mmc ?? '/mmc';

      const mmmCancelSlash = slashCommands.mmmCancel ?? '/mmm-cancel';

      
      if (!identifier) {
        return undefined;
      }
      
      const cleanedBody = event.cleanedBody || '';
      const messageText = cleanedBody.trim();

      // Activation: /mmm or voice "multi-message mode"
      if (isActivationRequest(cleanedBody, api.pluginConfig)) {
        api.logger.info(`[multi-message-mode] Activate command for ${identifier}`);
        const active = await isBatchActive(identifier);
        if (active) {
          return { handled: true, reply: { text: 'Multi-message mode already active.' } };
        }
        await activateBatch(identifier);
        return { handled: true, reply: { text: 'Multi-message mode activated. Send messages, then ' + mmcSlash + ' to release.' } };
      }
      
      // Cancel: /mmm-cancel only (no voice equivalent)
      if (isCancelRequest(cleanedBody, ctx.cfg)) {
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
      if (isDeactivationRequest(cleanedBody, ctx.cfg)) {
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
        const transcript = extractTranscript(cleanedBody);
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
      const mmcSlash = ctx.cfg?.slashCommands?.mmc ?? '/mmc';

      const isDeactivation = promptText.includes(mmcSlash) || isDeactivationRequest(promptText, ctx.cfg);
      
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
