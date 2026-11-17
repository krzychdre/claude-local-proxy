// Server-Sent Events parsing and emission.
//
// `parseSSE` is the one SSE parser in the proxy: the OpenAI stream translator
// and the usage scan of the transparent reverse proxy both read through it.
// `writeAnthropicMessageSse` goes the other way, for the one path that has a
// finished message but owes the client a stream.

// Yield one parsed JSON object per `data:` event in the stream. Blank `data:`
// lines and the `[DONE]` sentinel are skipped; non-JSON payloads are skipped.
export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      yield j;
    }
  }
}

// Emit one content block as start (+ deltas) + stop. `text`, `thinking` and
// `tool_use` are replayed the way a real stream builds them — empty shell first,
// content as deltas — because clients accumulate those three. Anything else
// (redacted_thinking, server_tool_use, web_search_tool_result, ...) is handed over
// whole in content_block_start, which is what the API itself does for blocks
// that have no delta form. Nothing is dropped.
function sendBlock(send, index, b) {
  if (b.type === 'text') {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    if (b.text) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
  } else if (b.type === 'thinking') {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    if (b.thinking) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
    // The signature is what lets the model re-accept its own thinking on the
    // next turn, so it has to survive the round trip.
    if (b.signature) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } });
  } else if (b.type === 'tool_use') {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } });
  } else {
    send('content_block_start', { type: 'content_block_start', index, content_block: b });
  }
  send('content_block_stop', { type: 'content_block_stop', index });
}

// Replay a complete Anthropic message object as a well-formed Anthropic SSE
// stream. Used by the web-tool resolver, which must buffer the model's output
// (it may have to run a search and ask again) even though Claude Code asked for
// `stream: true`.
export function writeAnthropicMessageSse(res, msg) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('message_start', {
    type: 'message_start',
    message: {
      id: msg.id || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: msg.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...msg.usage, output_tokens: 0 },
    },
  });
  send('ping', { type: 'ping' });

  let index = 0;
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    sendBlock(send, index, b);
    index++;
  }

  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: msg.stop_reason || 'end_turn', stop_sequence: msg.stop_sequence ?? null },
    usage: { output_tokens: msg.usage.output_tokens },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}
