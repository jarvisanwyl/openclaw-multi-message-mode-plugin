# Multi‑Message Mode Plugin Specification

## Overview

The **Multi‑Message Mode** plugin buffers multiple incoming messages and releases them as a single concatenated block when deactivated. This enables voice‑note batching, long‑form input, and uninterrupted multi‑message workflows.

The plugin intercepts inbound messages via the OpenClaw `before_agent_reply` hook, stores them in a session‑scoped buffer, and blocks them from reaching the agent. When the batch is complete, the buffer is injected into the LLM prompt via the `before_prompt_build` hook, allowing the agent to process all accumulated messages as a single request.

## Activation & Deactivation

### 1. Slash‑command triggers (fast typing)

| Command | Meaning | Action |
|---------|---------|--------|
| `/mmm`  | Multi‑Message Mode | Activate batch mode |
| `/mmc`  | Multi‑Message Complete | Deactivate batch mode |
| `/mmm‑cancel` | Cancel batch | Discard buffer and deactivate |

### 2. Voice‑transcript triggers

| Spoken phrase | Meaning | Detection logic |
|---------------|---------|-----------------|
| `multi‑message mode`   | Activate batch mode | See “Voice detection” below |
| `multi‑message complete` | Deactivate batch mode | See “Voice detection” below |

**Note:** Voice cancellation (`multi‑message cancel`) is not implemented; use `/mmm‑cancel`.

### 3. Voice detection algorithm (Current status – broken)

**Problem:** Since OpenClaw v2026.4.5, voice‑note transcripts are **no longer embedded in `cleanedBody`**. Instead, the transcript is written to a separate JSON file next to the audio file, and `cleanedBody` remains `<media:audio>` placeholder. As a result, voice‑activation detection in `before_agent_reply` no longer works.

**Where the transcript lives:**
- Audio file: `/home/janwyl/.openclaw/media/inbound/file_<uuid>.ogg`
- Transcript file: `/home/janwyl/.openclaw/media/inbound/file_<uuid>.json` (contains `{"text": "transcript here", "usage": {"type": "duration", "seconds": <number>}}`)
  - **Example**: `{"text": "Another test message, let's see what this gives.", "usage": {"type": "duration", "seconds": 3}}`
- The plugin's `before_agent_reply` hook sees only `<media:audio>` in `cleanedBody`.
- The plugin's `before_prompt_build` hook sees a media‑attachment line in `event.prompt` (e.g., `[media attached: /home/janwyl/.openclaw/media/inbound/file_…]`).
- The transcript is **not present** in `event.transcript`, `event.media`, or `event.messages`.

**Proposed fix (deferred‑transcript approach):**

Since the whisper transcript is created **after** `before_prompt_build`, we bridge the timing gap by storing a reference to the audio file and checking for the transcript on the **next** message.

**Flow:**
1. **`before_prompt_build`** (when voice note arrives):
   - Detect audio file path in `event.prompt` (media‑attachment line).
   - Store the audio file path (or derived JSON path) in a temporary file keyed by session identifier: `/tmp/openclaw/multi‑message‑mode/pending/<normalized‑session‑id>.txt`.
   - Do **not** attempt activation yet (transcript doesn’t exist).

2. **Whisper transcription** happens asynchronously; JSON file is created.

3. **`before_agent_reply`** (on the **next** message):
   - Check for a pending‑audio file for the current session.
   - If found:
     - Read the stored audio file path.
     - Derive JSON path (`audioPath.replace(/\.ogg$/, '.json')`).
     - If JSON exists, read transcript (`text` property).
     - Use transcript for **voice activation detection** (if batch inactive) or **voice buffering** (if batch active).
     - Delete the pending‑audio file after processing.
   - Then proceed with normal text‑command detection and buffering.

**Result:**
- Voice activation is deferred to the **next** message, but works because the transcript is available by then.
- Voice buffering also works: the transcript (not `<media:audio>` placeholder) is stored in the buffer.
- Text commands (`/mmm`, `/mmc`, `/mmm‑cancel`) and text buffering continue to work immediately.

**Edge cases:**
- If the user sends `/mmc` immediately after a voice activation command, the pending audio may not be processed. Consider processing pending audio **before** deactivation.
- If the user sends multiple voice notes in quick succession, we may need to store multiple pending files (append to list).

**Text‑command activation** (`/mmm`, `/mmc`, `/mmm‑cancel`) and **text‑message buffering** continue to work via `before_agent_reply` (they do not rely on transcripts).

**Examples of current behavior:**
- `cleanedBody` = `<media:audio>` (13 chars) – no transcript.
- `event.prompt` = `[media attached: /home/janwyl/.openclaw/media/inbound/file_…]` – contains audio‑file path.
- Transcript file exists and contains correct text, but plugin cannot access it in `before_agent_reply`.
- Voice activation currently fails; slash‑command activation works.

## Behavior

### Activation (`/mmm` or voice `multi‑message mode`)
1. Create a batch‑state directory for the session (`/tmp/openclaw/multi‑message‑mode/batch/<normalized‑session‑id>/`).
2. Write an `active` flag file.
3. Create empty `buffer.txt` and `meta.json` files.
4. Reply with a short confirmation (“Multi‑message mode activated. Send messages, then /mmc to release.”).
5. **All subsequent messages are blocked** (see “Buffering”).

### Buffering (while active)
1. Each inbound message (except activation/deactivation commands) is:
   - Appended to `buffer.txt` with a server‑side ISO‑8601 timestamp.
   - Counted and timestamped in `meta.json`.
2. The plugin returns `{ handled: true, reply: { text: 'Message buffered.' } }` to block the message from reaching the agent and give the user visible feedback.
3. Voice messages are stripped of their surrounding metadata; only the transcript line is stored.

### Deactivation (`/mmc` or voice `multi‑message complete`)
1. Remove the `active` flag file (keep the buffer on disk).
2. **Let the deactivation message pass through** to `before_prompt_build`.
3. In `before_prompt_build`, read `buffer.txt`, delete the entire batch directory, and inject the buffer content into the LLM prompt via `prependContext`.
4. The agent receives a single prefixed context block containing all buffered messages in chronological order.

### Cancellation (`/mmm‑cancel`)
1. Delete the entire batch directory, discarding any buffered content.
2. Reply with “Multi‑message mode cancelled.”

## State & Persistence

- **Location**: `/tmp/openclaw/multi‑message‑mode/batch/<normalized‑session‑id>/`
- **Files**:
  - `active` – empty flag file (exists → batch is active)
  - `buffer.txt` – concatenated messages with timestamps and separators (`[<timestamp>] message\n---\n`)
  - `meta.json` – activation time, message count, last‑appended timestamp
- **Session identification**: Extracted from `sessionKey` using regex; format `channelId:conversationId` (e.g., `telegram:-1003690577722:topic:1867`).
- **Clean‑up**: Batch directories are deleted after injection; no persistent state remains.

## Plugin Hooks

- **`before_agent_reply`**: 
  - Handles text‑command activation (`/mmm`), cancellation (`/mmm‑cancel`), deactivation (`/mmc`).
  - Buffers text messages when batch is active.
  - Checks for pending audio transcript (from `before_prompt_build`) and processes for voice activation or buffering.

- **`before_prompt_build`**: 
  - Detects audio file in prompt (media‑attachment line).
  - Stores audio file path in a pending file for later processing.
  - Handles deactivation (`/mmc` or voice `multimessagecomplete`) and injects buffered content.activation detection. Blocks agent turns while batch is active.
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

## Implementation Status (as of 2026‑04‑06)

✅ **Text‑command detection** – `/mmm`, `/mmc`, `/mmm‑cancel` work via `before_agent_reply`.
✅ **Text‑message buffering** – Works when batch is active (via `before_agent_reply`).
✅ **Deactivation & buffer injection** – `/mmc` triggers `before_prompt_build` and injects buffered content.
✅ **File‑system operations** – `activateBatch`, `appendToBuffer`, `deactivateBatch`, `cancelBatch`.
❌ **Voice‑activation** – Broken (transcript not in `cleanedBody`).
❌ **Voice‑message buffering** – Broken (buffers `<media:audio>` placeholder, not transcript).
⚠️ **Voice detection in `before_prompt_build`** – Not yet implemented.

**Next steps:**
1. Implement deferred‑transcript approach:
   - In `before_prompt_build`, store audio file path in pending file keyed by session.
   - In `before_agent_reply`, check for pending file, read transcript JSON, handle activation/buffering.
2. Handle edge cases (e.g., `/mmc` before pending audio is processed).
3. Test with multiple sequential voice notes.
4. Keep text‑command detection and text‑message buffering unchanged in `before_agent_reply`.

---

*Last updated: 2026‑04‑06*  
*Plugin ID: `multi‑message‑mode`*