// Server-Sent Events parsing — the single source of truth.
//
// `parseSSE` is the generic line/sse parser (async generator of decoded JSON
// payloads). The Anthropic-usage extractor is built on top of it so the
// transparent reverse-proxy can scan a relayed stream for usage without a
// second hand-rolled parser.

// Yield one parsed JSON object per `data:` event in the stream. Blank `data:`
// lines and the `[DONE]` sentinel are skipped; non-JSON payloads are skipped.
export async function* parseSSE(body, decoder) {
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
