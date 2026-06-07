# Multi‑Message Mode Plugin Specification

## Overview

The **Multi‑Message Mode** plugin buffers multiple incoming messages and releases them as a single concatenated block when deactivated. This enables voice‑note batching, long‑form input, and uninterrupted multi‑message workflows.

The plugin intercepts inbound messages via the OpenClaw `before_agent_reply` hook, stores them in a session‑scoped buffer, and blocks them from reaching the agent. When the batch is complete, the buffer is injected into the LLM prompt via the `before_prompt_build` hook, allowing the agent to process all accumulated messages as a single request.

## Configuration

The plugin's slash commands, voice‑transcript keywords, and echo behaviour can be customized via OpenClaw's plugin configuration system. The default values are those listed in the tables below.

### Configurable Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `slashCommands.activate` | string | `/mmm` | Slash command to activate multi‑message mode |
| `slashCommands.deactivate` | string | `/mmc` | Slash command to deactivate multi‑message mode |
| `slashCommands.cancel` | string | `/mmm‑cancel` | Slash command to cancel batch and discard buffer |
| `voiceKeywords.activate` | string | `multi‑message mode` | Spoken phrase (transcript) that activates batch mode |
| `voiceKeywords.deactivate` | string | `multi‑message complete` | Spoken phrase that deactivates batch mode |
| `voiceKeywords.cancel` | string | `multi‑message cancel` | Spoken phrase that cancels the batch |
| `echoBuffer` | boolean | `true` | When `true`, voice note acknowledgments echo the captured transcript so the user can verify transcription accuracy. Plain text messages are never echoed. |
| `echoTruncation` | integer | `200` | Maximum characters shown in the echo before truncating with `...`. Set to `0` for no truncation. Only applies when `echoBuffer` is `true`. |

### Configuration Example

Add the following to your `openclaw.json` under `"plugins": { "multi‑message‑mode": { ... } }`:

```json
{
  "plugins": {
    "multi‑message‑mode": {
      "slashCommands": {
        "activate": "/batch",
        "deactivate": "/release",
        "cancel": "/batch-cancel"
      },
      "voiceKeywords": {
        "activate": "start batching",
        "deactivate": "finish batching",
        "cancel": "discard batching"
      },
      "echoBuffer": false,
      "echoTruncation": 120
    }
  }
}
```

### Reading Configuration in Plugin Code

The plugin receives its configuration via `api.pluginConfig` in hook handlers. For example:

```javascript
const slashCommands = api.pluginConfig?.slashCommands ?? {};
const voiceKeywords = api.pluginConfig?.voiceKeywords ?? {};
const mmmSlash = slashCommands.activate ?? '/mmm';
const voiceActivate = voiceKeywords.activate ?? 'multi-message mode';
const voiceDeactivate = voiceKeywords.deactivate ?? 'multi-message complete';
const echoBuffer = api.pluginConfig?.echoBuffer ?? true;
const rawEchoTruncation = api.pluginConfig?.echoTruncation;
const echoTruncation = rawEchoTruncation === undefined ? 200 : (rawEchoTruncation > 0 ? rawEchoTruncation : 0);
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
| `multi‑message mode`   | Activate batch mode | See "Voice detection" below |
| `multi‑message complete` | Deactivate batch mode | See "Voice detection" below |
| `multi‑message cancel` | Cancel batch | See "Voice detection" below |

*These are the default phrases; they can be configured via plugin settings.*

### 3. Voice detection algorithm

When a voice message arrives, its transcript is embedded in the `cleanedBody` field. Two formats are supported and tried in order:

**Format A — New Telegram DM format:**

```
[Audio transcript (machine-generated, untrusted)]: "Multi-message mode."
```

The transcript is captured by matching the `[Audio transcript (machine-generated, untrusted)]:` marker and extracting the quoted string.

**Format B — General / older format:**

```
[Audio]
User text:
<untrusted body>
Transcript:
Multi-message mode
```

The transcript is captured by matching the `Transcript:` line, taking everything up to the next `\n---` separator (or end of input).

*Note:* The phrases `Multi‑message mode`, `Multi‑message complete`, and `Multi‑message cancel` are the **default** activation/deactivation/cancel keywords; they can be customized via the plugin's `voiceKeywords` configuration (see [Configuration](#configuration)).

Detection steps (applied to the extracted transcript, regardless of source format):
1. **Extract transcript**: try Format A first, then Format B; if neither matches, no transcript is available and the message is treated as normal content.
2. **Length filter**: If the extracted transcript exceeds 30 characters, treat as normal content (skip keyword detection).
3. **Normalization**:
   - Convert the transcript to lowercase.
   - Remove all non‑letter characters (a‑z).
4. **Exact match**:
   - If the normalized string equals `multimessagemode` → **activation**.
   - If the normalized string equals `multimessagecomplete` → **deactivation**.
   - If the normalized string equals `multimessagecancel` → **cancellation**.
   - Otherwise, treat as normal content.

   *These are the default normalized keywords; they correspond to the configured `voiceKeywords.activate`, `voiceKeywords.deactivate`, and `voiceKeywords.cancel` settings.*

**Examples**:
- `"Multi‑message mode!"` → `multimessagemode` → activate
- `"Multi‑message complete."` → `multimessagecomplete` → deactivate
- `"Multi‑message cancel."` → `multimessagecancel` → cancel
- `"Okay, let's start a long multi‑message mode session right now"` → transcript length > 30 → ignore (treated as buffered content)
- `"Let's start multi-message mode now"` → 32 chars, length > 30 → ignore (treated as buffered content)

## Behavior

### Activation (`/mmm` or voice `multi‑message mode`)

*These are the default triggers; both slash command and voice keyword can be customized via plugin configuration.*
1. Create a batch‑state directory for the session (`/tmp/openclaw/multi‑message‑mode/batch/<normalized‑session‑id>/`).
2. Write an `active` flag file.
3. Create empty `buffer.txt` and `meta.json` files.
4. Reply with a short confirmation using the configured `slashCommands.deactivate` and `voiceKeywords.deactivate` values. With defaults, the message reads: `Multi‑message mode activated. Send messages, then type /mmc or say "multi-message complete" to release.`
5. **All subsequent messages are blocked** (see "Buffering" and "Message Acknowledgments").

### Buffering (while active)
1. Each inbound message (except activation/deactivation/cancellation commands) is:
   - Appended to `buffer.txt` with a server‑side ISO‑8601 timestamp.
   - Counted and timestamped in `meta.json`.
2. Voice messages are stripped of their surrounding metadata; only the transcript line is stored.
3. The message is blocked from reaching the agent; a visible acknowledgment is sent to the user (see "Message Acknowledgments").

### Message Acknowledgments

When a message is buffered, the plugin returns `{ handled: true, reply: { text: ... } }` to block the message from reaching the agent. The text of the acknowledgment is built by the `buildAckText` helper and depends on the `echoBuffer` and `echoTruncation` config options:

- **`echoBuffer: false`** (or no transcript available) → the reply is always `Message buffered.`
- **`echoBuffer: true` and a transcript is available** → the reply echoes the transcript: `Message buffered: "transcript content"`.
- **`echoBuffer: true`, transcript available, length exceeds `echoTruncation`** → the reply is truncated: `Message buffered: "first N chars..."` where N is the configured `echoTruncation`. With the default of `200`, transcripts longer than 200 characters are cut and an ellipsis is appended. **Only truncate when the message actually exceeds the limit** — do not add an ellipsis if it fits exactly.
- **`echoBuffer: true`, transcript available, but no truncation desired** → set `echoTruncation: 0` to disable truncation entirely.
- **Plain text messages** are never echoed regardless of `echoBuffer`; the user already sees what they typed.

The defensive handling: if `echoTruncation` is negative, treat as `0` (no truncation). Missing config falls back to the schema defaults (`echoBuffer: true`, `echoTruncation: 200`).

### Deactivation (`/mmc` or voice `multi‑message complete`)

*These are the default triggers; both slash command and voice keyword can be customized via plugin configuration.*
1. Remove the `active` flag file (keep the buffer on disk).
2. **Let the deactivation message pass through** to `before_prompt_build`.
3. In `before_prompt_build`, read `buffer.txt`, delete the entire batch directory, and inject the buffer content into the LLM prompt via `prependContext`.
4. The agent receives a single prefixed context block containing all buffered messages in chronological order, prefixed with an instruction to ignore the deactivation command itself.

If the batch is released with an empty buffer (no messages were buffered), `before_prompt_build` injects a placeholder `The user released a multi-message batch, but no messages were buffered.` instead of an empty buffer block.

### Cancellation (`/mmm‑cancel` or voice `multi‑message cancel`)

*This is the default slash command and voice phrase; both can be customized via plugin configuration.*
1. Delete the entire batch directory, discarding any buffered content.
2. Reply with "Multi‑message mode cancelled."
3. Cancelling a non‑active batch replies "No active multi‑message batch."

## State & Persistence

- **Location**: `/tmp/openclaw/multi‑message‑mode/batch/<normalized‑session‑id>/`
- **Files**:
  - `active` – empty flag file (exists → batch is active)
  - `buffer.txt` – concatenated messages with timestamps and separators (`[<timestamp>] message\n---\n`)
  - `meta.json` – activation time, identifier, message count, last‑appended timestamp
- **Session identification**: Extracted from `sessionKey` using regex; format `channelId:conversationId` (e.g., `telegram:-1003690577722:topic:1867`).
- **Clean‑up**: Batch directories are deleted after injection (on deactivation) or on cancellation. No persistent state remains.
- **Identifier normalization**: Non‑alphanumeric characters (besides `_`, `.`, `-`) in the session identifier are replaced with `_` for use as a directory name.

## Plugin Hooks

- **`before_agent_reply`** (priority 100): Handles activation, cancellation, buffering, and deactivation detection. Blocks agent turns while batch is active and returns the acknowledgment reply.
- **`before_prompt_build`** (priority 100): Detects deactivation messages (`/mmc` or voice), reads the buffer, cleans up the directory, and injects the buffer via `prependContext`.

## Edge Cases & Error Handling

- **Plugin restart**: Batch state survives because it's stored on disk.
- **Multiple sessions**: Each chat gets its own isolated buffer.
- **Concurrent activation**: If already active, `/mmm` replies "Multi‑message mode already active."
- **Deactivation without activation**: Ignored in `before_agent_reply` (no `active` flag to remove); `before_prompt_build` is a no‑op if there is no buffered content.
- **Buffer read/write failures**: Warnings are logged via `api.logger.warn`; the plugin continues without crashing. Failed buffer appends do not update metadata.
- **Ordering guarantee**: Messages are buffered in the order they trigger the `before_agent_reply` hook. With queue depth 0 (`collect` mode), this matches send order.
- **Voice transcription timing**: Each voice note is a separate hook invocation; transcription delays do not reorder messages.
- **Empty buffer on release**: `before_prompt_build` injects a placeholder message rather than failing.
- **Very long buffers**: No size or message‑count limits are enforced (consider adding in future versions).

## Implementation Status

✅ All detection logic implemented (`extractTranscript`, `normalizeText`, `isActivationRequest`, `isDeactivationRequest`, `isCancelRequest`)
✅ Configuration support (slash commands, voice keywords, echo options) via `api.pluginConfig`
✅ File‑system operations (`activateBatch`, `appendToBuffer`, `deactivateBatch`, `cancelBatch`)
✅ Voice‑activation working with both Telegram DM and general transcript formats
✅ Ordering preserved, clean‑up after injection
✅ Error logging for file‑system failures
✅ Voice cancellation (slash command and voice keyword)
✅ Echo acknowledgment (`echoBuffer` + `echoTruncation`) with truncation logic

---

*Last updated: 2026‑06‑07*  
*Plugin ID: `multi‑message‑mode`*
