# Multi‑Message Mode Plugin Specification

## Overview

The **Multi‑Message Mode** plugin buffers multiple incoming messages and releases them as a single concatenated block when deactivated. This enables voice‑note batching, long‑form input, and uninterrupted multi‑message workflows.

The plugin intercepts inbound messages via the OpenClaw `before_agent_reply` hook, stores them in a session‑scoped buffer, and blocks them from reaching the agent. When the batch is complete, the buffer is injected into the LLM prompt via the `before_prompt_build` hook, allowing the agent to process all accumulated messages as a single request.

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

#### Required Telegram streaming configuration (for transcript preservation)

Transcript preservation depends on the OpenClaw `message_sending` hook being dispatched on **all** outbound (auto-reply) paths from the Telegram channel adapter. Without configuring the channel's streaming mode, the SDK's outbound aggregator takes an optimised path on auto-reply agent outbounds that bypasses plugin hooks — so the buffer preamble is silently dropped even though everything else (buffering, `prependContext` injection, agent acknowledgement) works correctly. Per OpenClaw issue [#65535](https://github.com/openclaw/openclaw/issues/65535) the hook is unreliable against streaming-aware outbound paths unless the channel adapter is opted in via the account's `streaming.mode`.

The verified-working configuration, set on the Telegram account that hosts the plugin (typically `channels.telegram.accounts.default`):

```json
"channels": {
  "telegram": {
    "accounts": {
      "default": {
        "streaming": {
          "mode": "progress",
          "progress": {
            "toolProgress": true,
            "commandText": "raw"
          }
        }
      }
    }
  }
}
```

Notes:

- The plain `channels.telegram.streaming` block (top-level on the channel, not under an account) is also accepted by some OpenClaw builds, but the per-account form is the documented location and matches the working install's config.
- The value of `progress.toolProgress` and `progress.commandText` can be tuned; the plugin only requires `streaming.mode: "progress"` to engage the hook pipeline. Other modes may not engage it.
- This requirement applies **only** to transcript preservation. Activation, buffering, deactivation, cancellation, and `prependContext` injection all work without the streaming block — but if transcript preservation is the goal, this block must be present on every Telegram account that is used with the plugin.
- If a Telegram channel does not have this configuration, the plugin will load and run but the buffered messages will not appear in the session transcript on deactivation. There is no error: the SDK simply doesn't dispatch `message_sending` on the auto-reply path. Check the install's logs for `[multi-message-mode] message_sending` entries after `/mmd` — if those are absent, the streaming block is missing.

## Configuration

The plugin's slash commands, voice‑transcript keywords, and echo behaviour can be customized via OpenClaw's plugin configuration system. The default values are those listed in the tables below.

### Configurable Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `slashCommands.activate` | string | `/mma` | Slash command to activate multi‑message mode |
| `slashCommands.deactivate` | string | `/mmd` | Slash command to deactivate multi‑message mode |
| `slashCommands.cancel` | string | `/mmc` | Slash command to cancel batch and discard buffer |
| `voiceKeywords.activate` | string | `activate` | Spoken phrase (transcript) that activates batch mode |
| `voiceKeywords.deactivate` | string | `deactivate` | Spoken phrase that deactivates batch mode |
| `voiceKeywords.cancel` | string | `cancel` | Spoken phrase that cancels the batch |
| `echoBuffer` | boolean | `false` | When `true`, voice note acknowledgments echo the captured transcript so the user can verify transcription accuracy. Plain text messages are never echoed. |
| `echoTruncation` | integer | `200` | Maximum characters shown in the echo before truncating with `...`. Set to `0` for no truncation. Only applies when `echoBuffer` is `true`. |
| `bufferedMessagesHeader` | string | `User messages sent via multi-message mode:` | Heading rendered above the list of buffered messages in the transcript block. Set to `""` to suppress the heading. See [Transcript Preservation](#transcript-preservation). |
| `assistantReplyHeader` | string | `Assistant reply:` | Heading rendered above the assistant's reply in the transcript block. Set to `""` to suppress the heading. See [Transcript Preservation](#transcript-preservation). |

### Configuration Example

Add the following to your `openclaw.json`. The plugin entry must include `hooks.allowConversationAccess: true` (see [Prerequisites](#prerequisites)). Configurable parameters live under the `config` key:

```json
"multi-message-mode": {
  "enabled": true,
  "hooks": {
    "allowConversationAccess": true
  },
  "config": {
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
    "echoTruncation": 120,
    "bufferedMessagesHeader": "User messages sent via multi-message mode:",
    "assistantReplyHeader": "Assistant reply:"
  }
}
```

### Reading Configuration in Plugin Code

The plugin receives its configuration via `api.pluginConfig` in hook handlers. For example:

```javascript
const slashCommands = api.pluginConfig?.slashCommands ?? {};
const voiceKeywords = api.pluginConfig?.voiceKeywords ?? {};
const mmmSlash = slashCommands.activate ?? '/mma';
const voiceActivate = voiceKeywords.activate ?? 'activate';
const voiceDeactivate = voiceKeywords.deactivate ?? 'deactivate';
const echoBuffer = api.pluginConfig?.echoBuffer ?? true;
const rawEchoTruncation = api.pluginConfig?.echoTruncation;
const echoTruncation = rawEchoTruncation === undefined ? 200 : (rawEchoTruncation > 0 ? rawEchoTruncation : 0);
```

Configuration is optional; missing keys fall back to defaults.

## Activation & Deactivation

### 1. Slash‑command triggers (fast typing)

| Command | Meaning | Action |
|---------|---------|--------|
| `/mma`  | Multi‑Message Activate | Activate batch mode |
| `/mmd`  | Multi‑Message Deactivate | Deactivate batch mode |
| `/mmc`  | Multi‑Message Cancel | Discard buffer and deactivate |
| `/mmdel` | Multi‑Message Delete Last | Remove the most‑recent buffered message |

*These are the default commands; they can be configured via plugin settings.*

### 2. Voice‑transcript triggers

| Spoken phrase | Meaning | Detection logic |
|---------------|---------|-----------------|
| `activate`   | Activate batch mode | See "Voice detection" below |
| `deactivate` | Deactivate batch mode | See "Voice detection" below |
| `cancel` | Cancel batch | See "Voice detection" below |
| `delete last` | Delete last buffered message | See "Voice detection" below — two‑word phrase by design to reduce false positives from single‑word `delete` in natural speech |

*These are the default phrases; they can be configured via plugin settings.*

### 3. Voice detection algorithm

When a voice message arrives, its transcript is embedded in the `cleanedBody` field. Two formats are supported and tried in order:

**Format A — New Telegram DM format:**

```
[Audio transcript (machine-generated, untrusted)]: "activate"
```

The transcript is captured by matching the `[Audio transcript (machine-generated, untrusted)]:` marker and extracting the quoted string.

**Format B — General / older format:**

```
[Audio]
User text:
<untrusted body>
Transcript:
activate
```

The transcript is captured by matching the `Transcript:` line, taking everything up to the next `\n---` separator (or end of input).

*Note:* The phrases `activate`, `deactivate`, and `cancel` are the **default** activation/deactivation/cancel keywords; they can be customized via the plugin's `voiceKeywords` configuration (see [Configuration](#configuration)).

Detection steps (applied to the extracted transcript, regardless of source format):
1. **Extract transcript**: try Format A first, then Format B; if neither matches, no transcript is available and the message is treated as normal content.
2. **Length filter**: If the extracted transcript exceeds 30 characters, treat as normal content (skip keyword detection).
3. **Normalization**:
   - Convert the transcript to lowercase.
   - Remove all non‑letter characters (a‑z).
4. **Exact match**:
   - If the normalized string equals `activate` → **activation**.
   - If the normalized string equals `deactivate` → **deactivation**.
   - If the normalized string equals `cancel` → **cancellation**.
   - Otherwise, treat as normal content.

   *These are the default normalized keywords; they correspond to the configured `voiceKeywords.activate`, `voiceKeywords.deactivate`, and `voiceKeywords.cancel` settings.*

**Examples**:
- `"activate"` → `activate` (7 chars) → activate
- `"Activate!"` → `activate` → activate
- `"deactivate."` → `deactivate` → deactivate
- `"Cancel"` → `cancel` → cancel
- `"Okay, please go ahead and activate the long‑awaited feature now"` → 56 chars, length > 30 → ignore (treated as buffered content)
- `"I want to cancel my order please"` → 32 chars, length > 30 → ignore (treated as buffered content)

## Behavior

### Activation (`/mma` or voice `activate`)

*These are the default triggers; both slash command and voice keyword can be customized via plugin configuration.*
1. Create a batch‑state directory for the session (`/tmp/openclaw/multi‑message‑mode/batch/<normalized‑session‑id>/`).
2. Write an `active` flag file.
3. Create empty `buffer.txt` and `meta.json` files.
4. Reply with a short confirmation using the configured `slashCommands.deactivate` and `voiceKeywords.deactivate` values. With defaults, the message reads: `Multi‑message mode activated. Send messages, then type /mmd or say "deactivate" to release.`
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

The defensive handling: if `echoTruncation` is negative, treat as `0` (no truncation). Missing config falls back to the schema defaults (`echoBuffer: false`, `echoTruncation: 200`).

### Deactivation (`/mmd` or voice `deactivate`)

*These are the default triggers; both slash command and voice keyword can be customized via plugin configuration.*
1. Remove the `active` flag file (keep the buffer on disk).
2. **Let the deactivation message pass through** to `before_prompt_build`.
3. In `before_prompt_build`, read `buffer.txt`, **persist a one‑shot copy** to `consumed/<session-id>/buffer.txt`, delete the active batch directory, and inject the buffer content into the LLM prompt via `prependContext`.
4. The agent receives a single prefixed context block containing all buffered messages in chronological order, prefixed with an instruction to ignore the deactivation command itself.
5. The persisted copy in `consumed/` is consumed by the `message_sending` hook on the deactivation reply — see [Transcript Preservation](#transcript-preservation).

If the batch is released with an empty buffer (no messages were buffered), `before_prompt_build` injects a placeholder `The user released a multi-message batch, but no messages were buffered.` instead of an empty buffer block, and no copy is persisted.

### Delete‑Last Buffered Message (`/mmdel` or voice `delete last`)

*These are the default triggers; both slash command and voice keyword can be customized via plugin configuration (`slashCommands.deleteLast`, `voiceKeywords.deleteLast`).*

This is a corrective command useful while composing a multi‑message batch: if a recently buffered message was wrong or off‑topic, it can be removed without deactivating the batch or throwing away earlier entries.

1. Receives the request. If the batch is *not* active, the user gets `Multi-message mode is not active.` and nothing is changed.
2. If the batch is active but `buffer.txt` is empty (or absent), the user gets `No messages to delete.` — the batch stays active.
3. Otherwise, the most‑recent entry is removed by truncating `buffer.txt` **just past** the last `\n-|-\n[` boundary — i.e. dropping the matched separator and the last entry but **keeping the previous entry's terminator intact** so the buffer remains well‑formed for any subsequent appending (this is the slice‑boundary handling verified by commit `9c7346e`; slicing to the bracket alone leaves the survivor malformed). `meta.json:messageCount` is decremented (floored at 0); `lastRemovedAt` is set. Earlier buffered messages are preserved; subsequent messages continue to buffer as normal.
4. The reply confirming removal is `Last buffered message removed.`.

The deletion command itself is **not** buffered — `before_agent_reply` returns `{ handled: true, ... }` and cancels the agent turn, exactly as activation / cancellation behave.

If `buffer.txt` somehow contains only a single entry with no trailing separator (a defensive case — current `appendToBuffer` always writes a trailing separator), the lone entry is cleared and `messageCount` decremented.

The on‑disk deletion happens against `batch/<id>/buffer.txt`; the deactivation pipeline still copies whatever remains to `consumed/<id>/buffer.txt` when the user eventually sends `/mmd`. So a deletion followed by deactivation produces a transcript block in the assistant's reply that reflects only the post‑deletion message set.

Spec: `data/coding/multi-message-mode/delete-last-message-upgrade.md`.

### Cancellation (`/mmc` or voice `cancel`)

*This is the default slash command and voice phrase; both can be customized via plugin configuration.*
1. Delete the entire batch directory, discarding any buffered content.
2. Reply with "Multi‑message mode cancelled."
3. Cancelling a non‑active batch replies "No active multi‑message batch."

### Transcript Preservation

Buffered messages that reach the LLM via `prependContext` are *ephemeral*: they are visible to the agent during the deactivation turn but are **not** written into the session transcript by the LLM runtime. Without preservation, the buffered content disappears as soon as the turn ends — it cannot be searched or retrieved later.

To make buffered messages part of the durable transcript history, the plugin runs an additional pipeline on the deactivation reply:

1. On deactivation in `before_prompt_build`, the buffer is **persisted** to `consumed/<normalized-session-id>/buffer.txt` before the active batch directory is deleted.
2. A new `message_sending` hook (priority 100) reads that consumed copy, formats the buffered entries into a transcript block, and returns it as a content patch on the outbound reply — using the SDK `return { content: ... }` contract that `runModifyingHook` consumes (in‑place mutation of `event.content` is ignored).
3. The merged content reaches both delivery (Telegram) **and** the session transcript store, making the buffered messages searchable in history.

**Transcript block shape** (defaults shown):

```
**User messages sent via multi-message mode:**

- "first buffered message"
- "second buffered message"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Assistant reply:**
[original assistant reply]
```

The two heading strings are configurable via `bufferedMessagesHeader` and `assistantReplyHeader` (both default to the strings above). Setting either to an empty string suppresses the corresponding heading; the messages and the reply still appear, just without a label.

The consumed directory is one‑shot: it is deleted inside `message_sending` once the patch is returned. If the hook fails to fire or the gateway crashes between `before_prompt_build` and `message_sending`, the consumed directory survives on disk as a recoverable artifact (a stale‑cleanup sweep could be added in a future version).

This feature applies to **deactivation only**. Cancellation (`/mmc`) deletes everything immediately; nothing is preserved, mirroring the explicit user intent to discard.

## State & Persistence

- **Active batch location**: `/tmp/openclaw/multi‑message‑mode/batch/<normalized‑session‑id>/`
- **Consumed (one‑shot) location**: `/tmp/openclaw/multi‑message‑mode/consumed/<normalized‑session‑id>/` — see [Transcript Preservation](#transcript-preservation).
- **Files** (under `batch/<id>/`):
  - `active` – empty flag file (exists → batch is active)
  - `buffer.txt` – concatenated messages with timestamps and separators (`[<timestamp>] message\n-|-\n`)
  - `meta.json` – activation time, identifier, message count, last‑appended timestamp
- **Files** (under `consumed/<id>/`):
  - `buffer.txt` – copy of the buffer at deactivation time, consumed by `message_sending` and then deleted
- **Session identification**: Extracted from `sessionKey` using regex; format `channelId:conversationId` (e.g., `telegram:-1003690577722:topic:1867`).
- **Clean‑up**: Batch directories are deleted on deactivation (after persist copy) or on cancellation. Consumed directories are one‑shot and deleted by `message_sending` after the patch is returned. No permanent state remains under normal flow.
- **Identifier normalization**: Non‑alphanumeric characters (besides `_`, `.`, `-`) in the session identifier are replaced with `_` for use as a directory name.

## Plugin Hooks

- **`before_agent_reply`** (priority 100): Handles activation, cancellation, buffering, and deactivation detection. Blocks agent turns while batch is active and returns the acknowledgment reply.
- **`before_prompt_build`** (priority 100): Detects deactivation messages (`/mmd` or voice), reads the buffer, **persists a copy** to `consumed/<id>/buffer.txt`, deletes the active directory, and injects the buffer via `prependContext`.
- **`message_sending`** (priority 100): Reads `consumed/<id>/buffer.txt` if present, formats it as a transcript block, returns it as a `{ content: ... }` patch on the outbound reply, then deletes the consumed directory. No‑op for ordinary replies without a deactivation pending. Requires the Telegram `streaming.mode: "progress"` configuration — see [Required Telegram streaming configuration](#required-telegram-streaming-configuration-for-transcript-preservation). See also [Transcript Preservation](#transcript-preservation).

## Edge Cases & Error Handling

- **Plugin restart**: Batch state survives because it's stored on disk.
- **Multiple sessions**: Each chat gets its own isolated buffer.
- **Concurrent activation**: If already active, `/mma` replies "Multi‑message mode already active."
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
✅ Transcript preservation: one‑shot consumed buffer + `message_sending` patch on deactivation reply; configurable `bufferedMessagesHeader` / `assistantReplyHeader`
⚠ Transcript preservation requires the Telegram channel account to be configured with `streaming.mode: "progress"` — see [Required Telegram streaming configuration](#required-telegram-streaming-configuration-for-transcript-preservation). Without it, the SDK does not dispatch `message_sending` on auto-reply outbounds and the buffered messages are silently dropped from the transcript.

---

*Last updated: 2026‑06‑24*  
*Plugin ID: `multi‑message‑mode`*
