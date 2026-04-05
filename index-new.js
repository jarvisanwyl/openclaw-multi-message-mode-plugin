import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'multi-message-mode',
  name: 'Multi-Message Mode',
  description: 'Plugin for buffering multiple messages before processing',
  
  register(api) {
    // Debug log to see what's available on api
    api.logger.info('[multi-message-mode] Plugin starting registration');
    api.logger.info('[multi-message-mode] api.keys:', Object.keys(api));
    api.logger.info('[multi-message-mode] api.runtime keys:', api.runtime ? Object.keys(api.runtime) : 'no runtime');
    api.logger.info('[multi-message-mode] api.on exists:', typeof api.on === 'function');
    api.logger.info('[multi-message-mode] api.registerHook exists:', typeof api.registerHook === 'function');
    
    // Register before_dispatch plugin hook using api.on (as seen in agent-passport plugin)
    api.on('before_dispatch', async (event, ctx) => {
      const now = new Date().toISOString();
      api.logger.info(`[multi-message-mode] PLUGIN HOOK BEFORE_DISPATCH CALLED at ${now}!`);
      
      // Log the inbound message
      api.logger.info('[multi-message-mode] EVENT object:', {
        content: event.content,
        contentLength: event.content?.length,
        sessionKey: event.sessionKey,
        senderId: event.senderId,
        channel: event.channel,
        isGroup: event.isGroup,
        body: event.body,
        eventKeys: Object.keys(event)
      });
      
      api.logger.info('[multi-message-mode] CONTEXT object:', {
        channelId: ctx.channelId,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        sessionKey: ctx.sessionKey,
        senderId: ctx.senderId,
        ctxKeys: Object.keys(ctx)
      });
      
      // Command detection
      const commands = {
        start: '/batch-start',
        end: '/batch-end', 
        cancel: '/batch-cancel',
      };
      
      let foundCommand = null;
      
      if (event.content?.includes(commands.start)) {
        foundCommand = 'start';
      } else if (event.content?.includes(commands.end)) {
        foundCommand = 'end';
      } else if (event.content?.includes(commands.cancel)) {
        foundCommand = 'cancel';
      }
      
      if (foundCommand) {
        api.logger.info(`[multi-message-mode] Command detected: ${foundCommand}`);
        const replyText = `Plugin: ${foundCommand} command detected and handled`;
        api.logger.info(`[multi-message-mode] Returning handled: true with text: ${replyText}`);
        return { handled: true, text: replyText };
      }
      
      // No command detected - pass through
      api.logger.info('[multi-message-mode] No command detected, passing through');
      return undefined;
    }, { priority: 100 });
    
    // Also register an internal hook for comparison (debug)
    if (api.registerHook && typeof api.registerHook === 'function') {
      api.registerHook('message:preprocessed', async (event, ctx) => {
        api.logger.info('[multi-message-mode] INTERNAL HOOK message:preprocessed called!');
      }, { name: 'multi-message-mode-internal-test' });
    }
    
    api.logger.info('[multi-message-mode] Plugin registered with before_dispatch hook via api.on');
  }
});