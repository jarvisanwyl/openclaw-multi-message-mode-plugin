# Multi‑Message Mode Plugin Specification

## Overview

The **Multi‑Message Mode** plugin buffers multiple incoming messages and releases them as a single concatenated block when deactivated. This enables voice‑note batching, long‑form input, and uninterrupted multi‑message workflows.

The plugin intercepts inbound messages via the OpenClaw `before_agent_reply` hook, stores them in a session‑scoped buffer, and blocks them from reaching the agent. When the batch is complete, the buffer is injected into the LLM prompt via the `before_prompt_build` hook, allowing the agent to process all accumulated messages as a single request.

## Configuration

The plugin's slash commands and voice‑transcript keywords can be customized via OpenClaw's plugin configuration system. The default values are those listed in the tables below.

### Configurable Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `slashCommands.mmm` | string | `/mmm` | Slash command to activate multi‑message mode |
| `slashCommands.mmc` | string | `/mmc` | Slash command to deactivate multi‑message mode |
| `slashCommands.mmmCancel` | string | `/mmm‑cancel` | Slash command to cancel batch and discard buffer |
| `voiceKeywords.activate` | string | `multi‑message mode` | Spoken phrase (transcript) that activates batch mode |
| `voiceKeywords.deactivate` | string | `multi‑message complete` | Spoken phrase that deactivates batch mode |

### Configuration Example

Add the following to your `openclaw.json` under `"plugins": { "multi‑message‑mode": { ... } }`:

```json
{
  "plugins": {
    "multi‑message‑mode": {
      "slashCommands": {
        "mmm": "/batch",
        "mmc": "/release",
        "mmmCancel": "/batch‑cancel"
      },
      "voiceKeywords": {
        "activate": "start batching",
        "deactivate": "finish batching"
      }
    }
  }
}
```

### Reading Configuration in Plugin Code

The plugin receives its configuration via the `ctx.cfg` object in hook handlers. For example:

```javascript
const mmmSlash = ctx.cfg?.slashCommands?.mmm ?? '/mmm';
const voiceActivate = ctx.cfg?.voiceKeywords?.activate ?? 'multi-message mode';
const voiceDeactivate = ctx.cfg?.voiceKeywords?.deactivate ?? 'multi-message complete';
```

Configuration is optional; missing keys fall back to defaults.

## Activation & Deactivation

### 1. Slash‑command triggers (fast typing)

| Command | Meaning | Action |
|---------|---------|--------|
| `/mmm`  | Multi‑Message Mode | Activate batch mode |
| `/mmc`  | Multi‑Message Complete | Deactivate batch mode |
| `/mmm‑cancel` | Cancel batch | Discard buffer and deactivate |

*These are the default commands; they can be configured via plugin settings.*

### 2. Voice‑transcript triggers

| Spoken phrase | Meaning | Detection logic |
|---------------|---------|-----------------|
| `multi‑message mode`   | Activate batch mode | See “Voice detection” below |
| `multi‑message complete` | Deactivate batch mode | See “Voice detection” below |

*These are the default phrases; they can be configured via plugin settings.*

**Note:** Voice cancellation (`multi‑message cancel`) is not implemented; use `/mmm‑cancel`.

### 3. Voice detection algorithm

When a voice message arrives, its transcript is embedded in the `cleanedBody` field with the format:
```
[Audio]
User text:
... Transcript:
Multi‑message mode.
```

*Note:* The phrases `Multi‑message mode` and `Multi‑message complete` are the **default** activation/deactivation keywords; they can be customized via the plugin’s `voiceKeywords` configuration (see [Configuration](#configuration)).

Detection steps:
1. **Extract transcript**: Look for `<media:audio>` and `Transcript:` markers; capture the line after `Transcript:`.
2. **Length filter**: If the extracted transcript exceeds 30 characters, treat as normal content (skip keyword detection).
3. **Normalization**:
   - Convert the transcript to lowercase.
   - Remove all non‑letter characters (a‑z).
4. **Exact match**:
   - If the normalized string equals `multimessagemode` → **activation**.
   - If the normalized string equals `multimessagecomplete` → **deactivation**.
   - Otherwise, treat as normal content.

   *These are the default normalized keywords; they correspond to the configured `voiceKeywords.activate` and `voiceKeywords.deactivate` settings.*

**Examples**:
- `"Multi‑message mode!"` → `multimessagemode` → activate
- `"Multi‑message complete."` → `multimessagecomplete` → deactivate
- `"Okay, multi‑message mode."` → transcript length > 30 → ignore (treated as buffered content)
- `"Let’s start multi‑message mode now"` → length > 30 → ignore

## Behavior

### Activation (`/mmm` or voice `multi‑message mode`)

*These are the default triggers; both slash command and voice keyword can be customized via plugin configuration.*
1. Create a batch‑state directory for the session (`/tmp/openclaw/multi‑message‑mode/batch/<normalized‑session‑id>/`).
2. Write an `active` flag file.
3. Create empty `buffer.txt` and `meta.json` files.
4. Reply with a short confirmation (“Multi‑message mode activated. Send messages, then /mmc to release.”). *The slash command `/mmc` is the default; it can be changed via configuration.*
5. **All subsequent messages are blocked** (see “Buffering”).

### Buffering (while active)
1. Each inbound message (except activation/deactivation commands) is:
   - Appended to `buffer.txt` with a server‑side ISO‑8601 timestamp.
   - Counted and timestamped in `meta.json`.
2. The plugin returns `{ handled: true, reply: { text: 'Message buffered.' } }` to block the message from reaching the agent and give the user visible feedback.
3. Voice messages are stripped of their surrounding metadata; only the transcript line is stored.

### Deactivation (`/mmc` or voice `multi‑message complete`)

*These are the default triggers; both slash command and voice keyword can be customized via plugin configuration.*
1. Remove the `active` flag file (keep the buffer on disk).
2. **Let the deactivation message pass through** to `before_prompt_build`.
3. In `before_prompt_build`, read `buffer.txt`, delete the entire batch directory, and inject the buffer content into the LLM prompt via `prependContext`.
4. The agent receives a single prefixed context block containing all buffered messages in chronological order.

### Cancellation (`/mmm‑cancel`)

*This is the default slash command; it can be customized via plugin configuration.*
1. Delete the entire batch directory, discarding any buffered content.
2. Reply with “Multi‑message mode cancelled.” *The slash command `/mmm‑cancel` is the default; it can be changed via configuration.*

## State & Persistence

- **Location**: `/tmp/openclaw/multi‑message‑mode/batch/<normalized‑session‑id>/`
- **Files**:
  - `active` – empty flag file (exists → batch is active)
  - `buffer.txt` – concatenated messages with timestamps and separators (`[<timestamp>] message\n---\n`)
  - `meta.json` – activation time, message count, last‑appended timestamp
- **Session identification**: Extracted from `sessionKey` using regex; format `channelId:conversationId` (e.g., `telegram:-1003690577722:topic:1867`).
- **Clean‑up**: Batch directories are deleted after injection; no persistent state remains.

## Plugin Hooks

- **`before_agent_reply`**: Handles activation, cancellation, buffering, and deactivation detection. Blocks agent turns while batch is active.
- **`before_prompt_build`**: Detects deactivation messages (`/mmc` or voice), reads the buffer, cleans up the directory, and injects the buffer via `prependContext`.

## Edge Cases & Error Handling

- **Plugin restart**: Batch state survives because it’s stored on disk.
- **Multiple sessions**: Each chat gets its own isolated buffer.
- **Concurrent activation**: If already active, `/mmm` replies “Multi‑message mode already active.”
- **Deactivation without activation**: Ignored (no state to clean).
- **Buffer read/write failures**: Warnings are logged via `api.logger.warn`; the plugin continues without crashing.
- **Ordering guarantee**: Messages are buffered in the order they trigger the `before_agent_reply` hook. With queue depth 0 (`collect` mode), this matches send order.
- **Voice transcription timing**: Each voice note is a separate hook invocation; transcription delays do not reorder messages.
- **Very long buffers**: No size or message‑count limits are enforced (consider adding in future versions).

## Implementation Status

✅ All detection logic implemented (`extractTranscript`, `normalizeText`, `isActivationRequest`, `isDeactivationRequest`, `isCancelRequest`)
✅ Configuration support (slash commands and voice keywords customizable via plugin config)
✅ File‑system operations (`activateBatch`, `appendToBuffer`, `deactivateBatch`, `cancelBatch`)
✅ Voice‑activation working with Telegram audio transcripts
✅ Ordering preserved, clean‑up after injection
✅ Error logging for file‑system failures

---

*Last updated: 2026‑04‑17*  
*Plugin ID: `multi‑message‑mode`*