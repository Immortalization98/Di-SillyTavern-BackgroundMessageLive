// Extracts the final reply text (and reasoning) from what SillyTavern's chat-completions endpoint
// returns for OpenAI-compatible sources: either an SSE stream or a single JSON body.

export const MAX_RESULT_CHARS = 2_000_000;

function readDelta(choice) {
  const delta = choice?.delta ?? choice?.message ?? {};
  const text = typeof delta.content === 'string' ? delta.content : (typeof choice?.text === 'string' ? choice.text : '');
  const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
    : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
  return { text, reasoning };
}

/** Incremental collector for an SSE body. Feed raw chunks (Buffer or string) in order. */
export function createStreamCollector() {
  let pending = '';
  let text = '';
  let reasoning = '';
  let error = null;
  let done = false;
  let tooLarge = false;
  const decoder = new TextDecoder();

  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event?.error) { error = event.error; return; }
    const choice = Array.isArray(event?.choices) ? event.choices[0] : null;
    if (!choice) return;
    const part = readDelta(choice);
    if (text.length + part.text.length > MAX_RESULT_CHARS) { tooLarge = true; return; }
    text += part.text;
    reasoning += part.reasoning;
  };

  return {
    push(chunk) {
      pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let index;
      while ((index = pending.search(/\r?\n/)) !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(pending[index] === '\r' ? index + 2 : index + 1);
        handleLine(line);
      }
    },
    finish() {
      pending += decoder.decode();
      if (pending) { handleLine(pending); pending = ''; }
      return { text, reasoning, done, error, tooLarge };
    },
  };
}

/** Parses a non-streaming JSON response body. */
export function parseJsonResponse(raw) {
  let body;
  try { body = JSON.parse(raw); } catch { return { text: '', reasoning: '', error: { message: 'invalid json' } }; }
  if (body?.error) return { text: '', reasoning: '', error: body.error };
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  const part = readDelta(choice);
  return { text: part.text.slice(0, MAX_RESULT_CHARS), reasoning: part.reasoning, error: null };
}
