# OpenClaw Multi-Message Mode Plugin

This plugin buffers multiple incoming messages and releases them as a single concatenated block when deactivated. Ideal for voice‑note batching, long‑form input, and uninterrupted multi‑message workflows.

## Features

- **Slash‑command activation**: `/mmm` to start, `/mmc` to release, `/mmm‑cancel` to discard
- **Voice‑activation**: Say "multi‑message mode" or "multi‑message complete" in a voice note (short phrases only)
- **Session‑scoped buffers**: Each conversation gets its own isolated buffer
- **Automatic blocking**: While active, messages are stored and the agent turn is cancelled
- **Injection via prependContext**: When released, the buffer is injected into the LLM prompt as a single request
- **Ordering guaranteed**: Messages are buffered in send order (sequential processing)
- **Clean‑up**: Buffer files are deleted after injection; no persistent state

## Installation

Place this folder inside your OpenClaw `plugins/` directory and ensure the plugin is enabled in your OpenClaw configuration.

## Usage

### Slash commands
1. Activate batch mode: send `/mmm`
2. Send any number of messages (text or voice). Each will be acknowledged with "Message buffered."
3. Release batch: send `/mmc`
4. The agent receives all buffered messages as a single context block and processes them together

### Voice activation
- Send a voice note saying **"multi‑message mode"** (exact phrase, ≤30 characters) to activate
- Send follow‑up messages (they will be buffered)
- Send a voice note saying **"multi‑message complete"** to release the batch

### Cancellation
- Send `/mmm‑cancel` at any time to discard the buffer and deactivate batch mode

## Configuration

No configuration schema is currently required. The plugin works out of the box.

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