# Multi‑Message Mode Plugin Specification

## Overview

The **Multi‑Message Mode** plugin buffers multiple incoming messages and releases them as a single concatenated block when deactivated. This enables voice‑note batching, long‑form input, and uninterrupted multi‑message workflows.

The plugin intercepts inbound messages via the OpenClaw `before_dispatch` hook, stores them in a session‑scoped buffer, and blocks them from reaching the agent. When the batch is complete, the buffer is written to disk, and a trigger message is allowed through so the agent can read and process the accumulated content.

## Activation & Deactivation

### 1. Slash‑command triggers (fast typing)

| Command | Meaning | Action |
|---------|---------|--------|
| `/mmm`  | Multi‑Message Mode | Activate batch mode |
| `/mmc`  | Multi‑Message Complete | Deactivate batch mode |

### 2. Keyword triggers (voice / spoken)

| Keyword phrase | Meaning | Detection logic |
|----------------|---------|-----------------|
| `multi‑message mode`   | Activate batch mode | See “Keyword detection” below |
| `multi‑message complete` | Deactivate batch mode | See “Keyword detection” below |

### 3. Keyword detection algorithm

For any inbound message:

1. **Length filter**: If the raw message text exceeds 30 characters, skip keyword detection (treat as normal content).
2. **Normalization**:
   - Convert the message to lowercase.
   - Remove all non‑letter characters (a‑z).
   - Remove all whitespace.
3. **Exact match**:
   - If the normalized string equals `multimessagemode` → **activation**.
   - If the normalized string equals `multimessagecomplete` → **deactivation**.
   - Otherwise, treat as normal content.

**Example**:
- `"Multi‑message mode!"` → `multimessagemode` → activate
- `"Multi‑message complete."` → `multimessagecomplete` → deactivate
- `"Okay, multi-message mode."` → `okaymultimessagemode` → ignore
- `"Let’s start multi‑message mode now"` → length > 30 → ignore

## Behavior

### Activation (`/mmm` or `multi‑message mode`)
1. Create a batch‑state directory for the session (`/tmp/openclaw/batch/<normalized‑session‑id>/`).
2. Write an `active` flag file.
3. Clear any existing buffer.
4. Reply with a short confirmation (e.g., “Multi‑message mode activated.”).
5. **All subsequent messages are blocked** (see “Buffering”).

### Buffering (while active)
1. Each inbound message (except activation/deactivation commands) is:
   - Appended to a `buffer.txt` file with a timestamp.
   - Counted in a `meta.json` file.
2. The plugin returns `{ handled: true, text: "✓" }` (a silent acknowledgment) to block the message from reaching the agent.

### Deactivation (`/mmc` or `multi‑message complete`)
1. Remove the `active` flag file (keep the buffer).
2. **Let the deactivation message pass through** (`{ handled: false }`).
3. The agent will receive the deactivation message, run the existing `check_batch.sh` script, and process the buffer as a single user input.

### Cancellation (optional)
A separate `/mmm‑cancel` command or keyword `multi-message cancel` can delete the batch directory entirely, discarding the buffer.

## State & Persistence

- **Location**: `/tmp/openclaw/batch/<normalized‑session‑id>/`
- **Files**:
  - `active` – empty flag file (exists → batch is active)
  - `buffer.txt` – concatenated messages with timestamps and separators
  - `meta.json` – activation time, message count, last‑appended timestamp
- **Session identification**: Use `channelId:conversationId` (e.g., `telegram:-1003690577722:topic:1867`).

## Integration with existing agent logic

The agent already has a `check_batch.sh` script that reads the buffer when it sees `/batch‑end`. The plugin will:

1. Keep the same file‑system layout so the script works unchanged.
2. Send `/mmc` (or `multi‑message complete`) as the trigger message.
3. The agent will run the script, receive `COMPLETE:<buffer‑content>`, and process it as a single user message.

## Edge Cases & Error Handling

- **Plugin restart**: Batch state survives because it’s stored on disk.
- **Multiple sessions**: Each chat gets its own isolated buffer.
- **Concurrent activation**: If already active, `/mmm` should reply “Already active” and keep buffering.
- **Deactivation without activation**: Ignore (no state to clean).
- **Very long buffers**: Consider a size limit (e.g., 10 KB) or message‑count limit (e.g., 50).

## Next Steps

1. Implement the detection logic in `index.js`.
2. Add file‑system operations (activate, append, deactivate, cancel).
3. Test with Telegram messages (text and audio transcripts).
4. Verify the agent’s `check_batch.sh` works with the new trigger messages.
5. Add error logging and recovery.

---

*Last updated: 2026‑04‑04*  
*Plugin ID: `multi‑message‑mode`*