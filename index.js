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

const PENDING_ROOT = '/tmp/openclaw/multi-message-mode/pending';

// Get pending audio file path for a given identifier
const getPendingAudioPath = (identifier) => {
  const normalized = normalizeIdentifier(identifier);
  return join(PENDING_ROOT, `audio_${normalized}.txt`);
};

// Store pending audio file path
const writePendingAudio = async (identifier, audioPath) => {
  await fs.mkdir(PENDING_ROOT, { recursive: true });
  const pendingPath = getPendingAudioPath(identifier);
  await fs.writeFile(pendingPath, audioPath);
};

// Read pending audio file path
const readPendingAudio = async (identifier) => {
  try {
    const pendingPath = getPendingAudioPath(identifier);
    return await fs.readFile(pendingPath, 'utf8');
  } catch (err) {
    return null;
  }
};

// Delete pending audio file
const deletePendingAudio = async (identifier) => {
  try {
    const pendingPath = getPendingAudioPath(identifier);
    await fs.unlink(pendingPath);
  } catch (err) {}
};



// Extract audio file path from prompt media-attachment line
// Format: "[media attached: /path/to/file.ogg ...]"
const extractAudioPathFromPrompt = (promptText) => {
  const match = promptText.match(/\[media attached: (\/[^ \]]+\.ogg)/);
  return match ? match[1] : null;
};

// Read transcript from JSON file (returns text property)
const readTranscriptFromJson = async (jsonPath) => {
  try {
    const data = await fs.readFile(jsonPath, 'utf8');
    const json = JSON.parse(data);
    return json.text || null;
  } catch (err) {
    return null;
  }
};

// Normalize text for keyword matching: lowercase, remove non-letter characters
const normalizeText = (text) => {
  return text.toLowerCase().replace(/[^a-z]/g, '');
};

// Check if cleanedBody is an activation request (/mmm only, voice handled in before_prompt_build)
const isActivationRequest = (cleanedBody) => {
  const trimmed = cleanedBody.trim();
  return trimmed === '/mmm';
};

// Check if cleanedBody is a deactivation request (/mmc only, voice handled in before_prompt_build)
const isDeactivationRequest = (cleanedBody) => {
  const trimmed = cleanedBody.trim();
  return trimmed === '/mmc';
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

// Get identifier from sessionKey
// sessionKey format: "agent:main:telegram:group:-1003690577722:topic:1867"
// We want: "telegram:-1003690577722:topic:1867" (skip the chat type)
const getSessionIdentifier = (sessionKey) => {
  if (sessionKey) {
    const match = sessionKey.match(/agent:\w+:(\w+):(?:group|user|channel):(.+)/);
    if (match) {
      return `${match[1]}:${match[2]}`;
    }
    // Fallback: try simpler pattern
    const fallback = sessionKey.match(/agent:\w+:(.+)/);
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
      api.logger.info(`[multi-message-mode] before_agent_reply event: ${JSON.stringify(event, null, 2)}`)
      api.logger.info(`[multi-message-mode] before_agent_reply ctx: ${JSON.stringify(ctx, null, 2)}`)

      try { 
        const testLoad = transcribeFirstAudio;
        api.logger.info(`[multi-message-mode] before_agent_reply imported transcribeFirstAudio`);
      } catch (err) {
        api.logger.info(`[multi-message-mode] before_agent_reply ERROR: Failed to import transcribeFirstAudio`);
      }
      
      const identifier = getIdentifier(ctx);
      if (!identifier) {
        return undefined;
      }
      
      // Check for pending audio from before_prompt_build
      const pendingAudio = await readPendingAudio(identifier);
      if (pendingAudio) {
        api.logger.info(`[multi-message-mode] before_agent_reply Found pending audio: ${pendingAudio}`);
        const transcriptPath = pendingAudio + '.txt'
        try {
          const transcript = await fs.readFile(transcriptPath, 'utf8');
          api.logger.info(`[multi-message-mode] before_agent_reply Transcript: ${transcript}`);
        } catch (err) {
          if (err.code === "ENOENT") {
            api.logger.info(`[multi-message-mode] before_agent_reply Transcript file ${transcriptPath} does not exist`);
          } else {
            throw err;
          }
        }
      }
      
      // // Check for pending audio from before_prompt_build
      // const pendingAudio = await readPendingAudio(identifier);
      // if (pendingAudio) {
      //   api.logger.info(`[multi-message-mode] Found pending audio: ${pendingAudio}`);
      //   const jsonPath = pendingAudio.replace(/\.ogg$/, '.json');
      //   const transcript = await readTranscriptFromJson(jsonPath);
      //   if (transcript) {
      //     api.logger.info(`[multi-message-mode] Read transcript: ${transcript}`);
      //     const normalized = normalizeText(transcript);
          
      //     // Voice activation detection
      //     if (normalized === 'multimessagemode') {
      //       api.logger.info(`[multi-message-mode] Voice activation detected for ${identifier}`);
      //       const active = await isBatchActive(identifier);
      //       if (active) {
      //         await deletePendingAudio(identifier);
      //         return { handled: true, reply: { text: 'Multi-message mode already active.' } };
      //       }
      //       await activateBatch(identifier);
      //       await deletePendingAudio(identifier);
      //       return { handled: true, reply: { text: 'Multi-message mode activated. Send messages, then /mmc to release.' } };
      //     }
          
      //     // Voice deactivation detection
      //     if (normalized === 'multimessagecomplete') {
      //       api.logger.info(`[multi-message-mode] Voice deactivation detected for ${identifier}`);
      //       const dir = getBatchDir(identifier);
      //       let bufferContent = '';
      //       try {
      //         bufferContent = await fs.readFile(join(dir, 'buffer.txt'), 'utf8');
      //       } catch (err) {}
            
      //       if (!bufferContent.trim()) {
      //         await deletePendingAudio(identifier);
      //         return { handled: true, reply: { text: 'The user released a multi-message batch, but no messages were buffered.' } };
      //       }
            
      //       // Clean up batch directory
      //       try {
      //         await cancelBatch(identifier);
      //       } catch (err) {
      //         api.logger.warn(`[multi-message-mode] Failed to clean up batch for ${identifier}: ${err.message}`);
      //       }
            
      //       await deletePendingAudio(identifier);
      //       // Return buffer content for processing
      //       return {
      //         handled: true,
      //         reply: { text: `The user has collected the following messages via multi-message mode. Process them as a single request:\n---\n${bufferContent}---\n\n` }
      //       };
      //     }
          
      //     // Voice buffering (if batch active)
      //     const active = await isBatchActive(identifier);
      //     if (active) {
      //       api.logger.info(`[multi-message-mode] Buffering voice transcript for ${identifier}`);
      //       await appendToBuffer(identifier, transcript);
      //       await deletePendingAudio(identifier);
      //       return { handled: true, reply: { text: 'Message buffered.' } };
      //     }
      //   }
      //   await deletePendingAudio(identifier);
      // }

      // // Activation: /mmm only (voice handled above)
      // if (isActivationRequest(cleanedBody)) {
      //   api.logger.info(`[multi-message-mode] Activate command for ${identifier}`);
      //   const active = await isBatchActive(identifier);
      //   if (active) {
      //     return { handled: true, reply: { text: 'Multi-message mode already active.' } };
      //   }
      //   await activateBatch(identifier);
      //   return { handled: true, reply: { text: 'Multi-message mode activated. Send messages, then /mmc to release.' } };
      // }
      
      // // Cancel: /mmm-cancel only (no voice equivalent)
      // if (isCancelRequest(cleanedBody)) {
      //   api.logger.info(`[multi-message-mode] Cancel command for ${identifier}`);
      //   const active = await isBatchActive(identifier);
      //   if (!active) {
      //     return { handled: true, reply: { text: 'No active multi-message batch.' } };
      //   }
      //   await cancelBatch(identifier);
      //   return { handled: true, reply: { text: 'Multi-message mode cancelled.' } };
      // }
      
      // // Deactivation: /mmc or voice "multi-message complete"
      // // Let through to before_prompt_build
      // if (isDeactivationRequest(cleanedBody)) {
      //   const active = await isBatchActive(identifier);
      //   if (active) {
      //     api.logger.info(`[multi-message-mode] /mmc received, deactivating for ${identifier}`);
      //     await deactivateBatch(identifier);
      //   }
      //   return undefined; // Let through to before_prompt_build
      // }
      
      // // Message buffering (when batch is active)
      // const active = await isBatchActive(identifier);
      // if (!active) {
      //   return undefined; // Let agent process normally
      // }
      
      // // Batch is active - buffer message and cancel agent turn
      // if (messageText) {
      //   await appendToBuffer(identifier, messageText);
      // }
      
      // return { handled: true, reply: { text: 'Message buffered.' } }; // Cancel agent turn and reply.
      
      return undefined
    }, { priority: 100 });

    // ========================================
    // reply_dispatch hook
    // ========================================
    
    api.on('reply_dispatch', async (event, ctx) => {
      const identifier = getSessionIdentifier(event.sessionKey);
      api.logger.info(`[multi-message-mode] reply_dispatch event: ${JSON.stringify(event, null, 2)}`)
      api.logger.info(`[multi-message-mode] reply_dispatch ctx: ${JSON.stringify(ctx, null, 2)}`)
      api.logger.info(`[multi-message-mode] reply_dispatch identifier: ${identifier}`)
      if (!identifier) {
        return undefined;
      }
      
      const bodyForAgent = event.ctx.BodyForAgent || '';
      const isAudioMessage = bodyForAgent == '<media:audio>';
      api.logger.info(`[multi-message-mode] reply_dispatch bodyForAgent: ${bodyForAgent}`)
      api.logger.info(`[multi-message-mode] reply_dispatch isAudioMessage: ${isAudioMessage}`)
      if (isAudioMessage) {
        const audioPath = event.ctx.MediaPath || '';
        api.logger.info(`[multi-message-mode] reply_dispatch audioPath: ${audioPath}`)
        const ext = extname(audioPath);
        const audioPathWithoutExt = audioPath.slice(0, -ext.length);
        await writePendingAudio(identifier, audioPathWithoutExt);
        api.logger.info(`[multi-message-mode] Storing pending audio path: ${audioPathWithoutExt}`)
      }
      api.logger.info(`[multi-message-mode] reply_dispatch event: ${JSON.stringify(event, null, 2)}`)
    return undefined
    }, { priority: 100 });
    
    
    // ========================================
    // before_prompt_build hook
    // Handles: stores pending audio path, deactivation, buffer injection
    // ========================================
    api.on('before_prompt_build', async (event, ctx) => {
      api.logger.info(`[multi-message-mode] before_prompt_build event: ${event.prompt}`)
      api.logger.info(`[multi-message-mode] before_prompt_build ctx: ${JSON.stringify(ctx, null, 2)}`)
      
      const identifier = getIdentifier(ctx);
      if (!identifier) {
        return undefined;
      }
      
      const pendingAudio = await readPendingAudio(identifier);
      if (pendingAudio) {
        api.logger.info(`[multi-message-mode] before_prompt_build Found pending audio: ${pendingAudio}`);
        const transcriptPath = pendingAudio + '.txt'
        try {
          const transcript = await fs.readFile(transcriptPath, 'utf8');
          api.logger.info(`[multi-message-mode] before_prompt_build Transcript: ${transcript}`);
        } catch (err) {
          if (err.code === "ENOENT") {
            api.logger.info(`[multi-message-mode] before_prompt_build Transcript file ${transcriptPath} does not exist`);
          } else {
            throw err;
          }
        }
      }
      
      // const identifier = getIdentifier(ctx);
      // if (!identifier) {
      //   return undefined;
      // }
      
      // // Check for audio file in prompt (media-attachment line)
      // const audioPath = extractAudioPathFromPrompt(promptText);
      // if (audioPath) {
      //   api.logger.info(`[multi-message-mode] Storing pending audio path: ${audioPath}`);
      //   await writePendingAudio(identifier, audioPath);
      // }
      
      // // Check for deactivation command
      // const normalized = normalizeText(promptText);
      // const isDeactivation = promptText.includes('/mmc') || normalized === 'multimessagecomplete';
      
      // if (!isDeactivation) {
      //   return undefined;
      // }
      
      // // Deactivation handling (voice or text)
      // api.logger.info(`[multi-message-mode] Deactivation triggered for ${identifier}`);
      
      // // Read the buffer
      // const dir = getBatchDir(identifier);
      // let bufferContent = '';
      // try {
      //   bufferContent = await fs.readFile(join(dir, 'buffer.txt'), 'utf8');
      // } catch (err) {}

      // if (!bufferContent.trim()) {
      //   return { prependContext: 'The user released a multi-message batch, but no messages were buffered.' };
      // }

      // // Clean up the batch directory (delete buffer files)
      // try {
      //   await cancelBatch(identifier);
      // } catch (err) {
      //   api.logger.warn(`[multi-message-mode] Failed to clean up batch for ${identifier}: ${err.message}`);
      // }

      // // Inject buffer content via prependContext
      // api.logger.info(`[multi-message-mode] Injecting ${bufferContent.length} chars via prependContext`);
      // return { 
      //   prependContext: `The user has collected the following messages via multi-message mode. Process them as a single request:\n---\n${bufferContent}---\n\n`
      // };
      
      return undefined
    }, { priority: 100 });
  }
});
