# OpenClaw Multi-Message Mode Plugin

This plugin buffers multiple incoming messages and releases them as a single concatenated block when deactivated. Ideal for voice‑note batching, long‑form input, and uninterrupted multi‑message workflows.

## Features

- **Slash‑command activation**: `/mma` to start, `/mmd` to release, `/mmc` to discard
- **Voice‑activation**: Say "activate", "deactivate", or "cancel" in a voice note (short phrases only)
- **Session‑scoped buffers**: Each conversation gets its own isolated buffer
- **Automatic blocking**: While active, messages are stored and the agent turn is cancelled
- **Injection via prependContext**: When released, the buffer is injected into the LLM prompt as a single request
- **Ordering guaranteed**: Messages are buffered in send order (sequential processing)
- **Clean‑up**: Buffer files are deleted after injection; no persistent state

## Prerequisites

For the plugin's hooks to fire, the plugin entry in `openclaw.json` must include `hooks.allowConversationAccess` set to `true`:

```json
"multi-message-mode": {
  "enabled": true,
  "hooks": {
    "allowConversationAccess": true
  }
}
```

Without this setting, the `before_agent_reply` hook will not receive conversation context, meaning messages cannot be intercepted and buffered. The plugin will not function.

## Installation

Place this folder inside your OpenClaw `plugins/` directory and ensure the plugin is enabled in your OpenClaw configuration.

## Usage

### Slash commands
1. Activate batch mode: send `/mma`
2. Send any number of messages (text or voice). Voice note acknowledgments will include the transcript for confirmation (see `echoBuffer` config). Plain text acknowledgments show "Message buffered."
3. Release batch: send `/mmd`
4. The agent receives all buffered messages as a single context block and processes them together

### Voice activation
- Send a voice note saying **"activate"** (exact phrase, ≤30 characters) to activate
- Send follow‑up messages (they will be buffered)
- Send a voice note saying **"deactivate"** to release the batch

### Cancellation
- Send `/mmc` at any time to discard the buffer and deactivate batch mode
- Or say **"cancel"** in a voice note

## Configuration

The plugin works out of the box with no configuration, but supports a few optional settings:

| Option | Type | Default | Description |
|---|---|---|---|
| `slashCommands.activate` | string | `/mma` | Slash command to start batch mode |
| `slashCommands.deactivate` | string | `/mmd` | Slash command to release the batch |
| `slashCommands.cancel` | string | `/mmc` | Slash command to discard the batch |
| `voiceKeywords.activate` | string | `activate` | Voice phrase to start batch mode |
| `voiceKeywords.deactivate` | string | `deactivate` | Voice phrase to release the batch |
| `voiceKeywords.cancel` | string | `cancel` | Voice phrase to discard the batch |
| `echoBuffer` | boolean | `true` | When `true`, voice note acknowledgments echo the captured transcript so the user can verify transcription accuracy. Plain text messages are never echoed (the user already sees them). |
| `echoTruncation` | integer | `200` | Maximum characters shown in the echo before truncating with `...`. Set to `0` for no truncation. Only applies when `echoBuffer` is `true`. |

## How it works

The plugin hooks into OpenClaw's `before_agent_reply` and `before_prompt_build` hooks:
- **Activation**: Creates a session‑specific directory under `/tmp/openclaw/multi‑message‑mode/batch/`
- **Buffering**: Appends each message (with timestamp) to `buffer.txt`
- **Deactivation**: Reads the buffer, deletes the directory, injects content via `prependContext`
- **Voice detection**: Extracts the transcript from Telegram's audio metadata, normalizes it, matches against keywords

## Documentation

See [SPECIFICATION.md](./SPECIFICATION.md) for detailed design, detection algorithm, and implementation notes.

## License

Private repository – all rights reserved.