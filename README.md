# OpenClaw Multi-Message Mode Plugin

This plugin enables buffering multiple incoming messages and releasing them as a single concatenated block when deactivated. Ideal for voice‑note batching, long‑form input, and uninterrupted multi‑message workflows.

## Features

- **Slash‑command activation**: `/mmm` to start, `/mmc` to release
- **Keyword triggers**: Supports voice activation via "multi‑message mode" and "multi‑message complete"
- **Session‑scoped buffers**: Each conversation gets its own isolated buffer
- **Automatic blocking**: While active, messages are stored and the agent turn is cancelled
- **Injection via prependContext**: When released, the buffer is injected into the LLM prompt as a single request

## Installation

Place this folder inside your OpenClaw `plugins/` directory and ensure the plugin is enabled in your OpenClaw configuration.

## Usage

1. Activate batch mode: send `/mmm`
2. Send any number of messages (they will be buffered, no agent replies)
3. Release batch: send `/mmc`
4. The agent receives all buffered messages as a single context block and processes them together

## Configuration

No configuration schema is currently required. The plugin works out of the box.

## Documentation

See [SPECIFICATION.md](./SPECIFICATION.md) for detailed design, keyword detection algorithm, and implementation notes.

## License

Private repository – all rights reserved.