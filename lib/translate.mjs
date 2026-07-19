// Anthropic <-> OpenAI Chat Completions translation.
//
// Used only for `localFlavor === 'openai'` backends. Converts an Anthropic
// /v1/messages request into an OpenAI chat-completions request, and the OpenAI
// response (streaming or not) back into Anthropic SSE/JSON — including tool
// calls, tool results, and images.

import { parseSSE } from './sse.mjs';
import { log } from './log.mjs';

// ---------------------------------------------------------------------------
// Request: Anthropic -> OpenAI
// ---------------------------------------------------------------------------

export function anthropicSystemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n');
  return '';
}

// Render an Anthropic tool_result's content to a plain string for OpenAI's
// `role: tool` message.
function toolResultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(x => (x.type === 'text' ? x.text : x.type === 'image' ? '[image]' : JSON.stringify(x))).join('\n');
  }
  return JSON.stringify(c ?? '');
}

// Convert an Anthropic assistant turn into one OpenAI assistant message
// (text + optional tool_calls).
function convertAssistantTurn(content, out) {
  let text = '';
  const toolCalls = [];
  for (const part of content) {
    if (part.type === 'text') {
      text += part.text;
    } else if (part.type === 'tool_use') {
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
      });
    }
  }
  const m = { role: 'assistant', content: text || null };
  if (toolCalls.length) m.tool_calls = toolCalls;
  out.push(m);
}

// Convert an Anthropic user turn into OpenAI messages. Tool results become
// their own `role: tool` messages (they must directly follow the assistant
// tool_calls), then any fresh text/images become the user message.
function convertUserTurn(content, out) {
  const userParts = [];
  const toolMsgs = [];
  for (const part of content) {
    if (part.type === 'text') {
      userParts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      const src = part.source || {};
      const url = src.type === 'base64' ? `data:${src.media_type};base64,${src.data}`
        : src.type === 'url' ? src.url : null;
      if (url) userParts.push({ type: 'image_url', image_url: { url } });
    } else if (part.type === 'tool_result') {
      toolMsgs.push({ role: 'tool', tool_call_id: part.tool_use_id, content: toolResultText(part.content) });
    }
  }
  for (const tm of toolMsgs) out.push(tm);
  if (!userParts.length) return;
  if (userParts.every(p => p.type === 'text')) {
    out.push({ role: 'user', content: userParts.map(p => p.text).join('\n') });
  } else {
    out.push({ role: 'user', content: userParts });
  }
}

export function convertMessages(messages) {
  const out = [];
  for (const msg of messages || []) {
    const { role, content } = msg;
    if (typeof content === 'string') { out.push({ role, content }); continue; }
    if (!Array.isArray(content)) { out.push({ role, content: String(content ?? '') }); continue; }
    if (role === 'assistant') convertAssistantTurn(content, out);
    else convertUserTurn(content, out);
  }
  return out;
}

export function convertTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools
    .filter(t => t && t.name) // skip server-side tool stubs without a schema
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
}

export function convertToolChoice(tc) {
  if (!tc) return undefined;
  switch (tc.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'tool': return { type: 'function', function: { name: tc.name } };
    case 'none': return 'none';
    default: return undefined;
  }
}

// Build the full OpenAI chat-completions request body from an Anthropic one.
export function toOpenAI(body, backendModel) {
  const messages = [];
  const sys = anthropicSystemToText(body.system);
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push(...convertMessages(body.messages));

  const o = { model: backendModel, messages, stream: !!body.stream };
  if (body.max_tokens != null) o.max_tokens = body.max_tokens;
  if (body.temperature != null) o.temperature = body.temperature;
  if (body.top_p != null) o.top_p = body.top_p;
  if (body.stop_sequences && body.stop_sequences.length) o.stop = body.stop_sequences;
  const tools = convertTools(body.tools);
  if (tools && tools.length) o.tools = tools;
  const tc = convertToolChoice(body.tool_choice);
  if (tc) o.tool_choice = tc;
  if (body.stream) o.stream_options = { include_usage: true };
  return o;
}

// ---------------------------------------------------------------------------
// Response: OpenAI -> Anthropic
// ---------------------------------------------------------------------------

export function mapFinish(fr) {
  switch (fr) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return fr ? 'end_turn' : null;
  }
}

let toolIdCounter = 0;
function newToolId(seed) { return `toolu_${Date.now().toString(36)}_${seed}_${toolIdCounter++}`; }

// Non-streaming: a single OpenAI completion -> an Anthropic message object.
export function fromOpenAINonStream(oai, model) {
  const choice = (oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tcl = msg.tool_calls[i];
      let input = {};
      try { input = JSON.parse(tcl.function?.arguments || '{}'); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tcl.id || newToolId(i), name: tcl.function?.name, input });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = oai.usage || {};
  return {
    id: oai.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinish(choice.finish_reason) || 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };
}

// Streaming: translate an OpenAI SSE stream into Anthropic SSE, writing to `res`.
// `onUsage(usage)` is called once with the final usage so the caller can log it.
//
// State that spans events: a lazily-opened text block (`textOpen`/`textIndex`)
// and one Anthropic tool_use block per OpenAI tool-call index (`toolBlocks`).
export async function streamOpenAIToAnthropic(up, res, model, onUsage) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const msgId = `msg_${Date.now()}`;
  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  send('ping', { type: 'ping' });

  let nextIndex = 0;
  let textOpen = false;
  let textIndex = -1;
  const toolBlocks = new Map(); // openai tool index -> { anthIndex }
  let finalStop = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };

  const closeText = () => {
    if (textOpen) { send('content_block_stop', { type: 'content_block_stop', index: textIndex }); textOpen = false; }
  };

  const decoder = new TextDecoder();
  let streamError = null;
  try {
    for await (const j of parseSSE(up.body, decoder)) {
      if (j.usage) {
        usage = {
          input_tokens: j.usage.prompt_tokens ?? usage.input_tokens,
          output_tokens: j.usage.completion_tokens ?? usage.output_tokens,
        };
      }
      const choice = (j.choices && j.choices[0]) || {};
      const delta = choice.delta || {};

      if (delta.content) {
        if (!textOpen) {
          textIndex = nextIndex++;
          textOpen = true;
          send('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
        }
        send('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const oaIdx = tc.index ?? 0;
          let blk = toolBlocks.get(oaIdx);
          if (!blk) {
            closeText(); // tool blocks come after any text block
            const anthIndex = nextIndex++;
            blk = { anthIndex };
            toolBlocks.set(oaIdx, blk);
            send('content_block_start', {
              type: 'content_block_start',
              index: anthIndex,
              content_block: { type: 'tool_use', id: tc.id || newToolId(oaIdx), name: tc.function?.name || '', input: {} },
            });
          }
          const argChunk = tc.function?.arguments;
          if (argChunk) {
            send('content_block_delta', { type: 'content_block_delta', index: blk.anthIndex, delta: { type: 'input_json_delta', partial_json: argChunk } });
          }
        }
      }

      if (choice.finish_reason) finalStop = mapFinish(choice.finish_reason) || 'end_turn';
    }
  } catch (e) {
    log('error', `stream relay error: ${e.message}`);
    streamError = e;
  }

  closeText();
  for (const blk of toolBlocks.values()) {
    send('content_block_stop', { type: 'content_block_stop', index: blk.anthIndex });
  }
  if (streamError) {
    send('error', { type: 'error', error: { type: 'api_error', message: `upstream stream error: ${streamError.message}` } });
  }
  send('message_delta', { type: 'message_delta', delta: { stop_reason: streamError ? 'end_turn' : finalStop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  send('message_stop', { type: 'message_stop' });
  res.end();
  onUsage(usage);
}

// Rough char/4 estimate so the local path needs no Anthropic dependency for
// count_tokens.
export function estimateTokens(body) {
  let chars = anthropicSystemToText(body.system).length;
  for (const m of body.messages || []) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p.type === 'text') chars += (p.text || '').length;
        else if (p.type === 'tool_result') chars += JSON.stringify(p.content || '').length;
        else if (p.type === 'tool_use') chars += JSON.stringify(p.input || '').length + (p.name || '').length;
      }
    }
  }
  if (body.tools) chars += JSON.stringify(body.tools).length;
  return Math.max(1, Math.ceil(chars / 4));
}
