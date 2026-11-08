// Where does a reply that finished in the background belong in the chat as it is now?
// Rules (never overwrite real content):
//  - the exact spot is still free                  → append a new reply
//  - a half-finished / empty reply sits in that spot → replace it
//  - a different, real reply sits in that spot       → add the result as a new swipe of it
//  - the chat has moved on in any other way          → mismatch (offer copy only)
// `messageCount` is the chat length right before the generate request was sent.

const isPlaceholderOf = (existing, full) => {
  const current = String(existing ?? '').trim();
  return !current || current === '...' || String(full).trim().startsWith(current);
};

export function planInsertion(chat, result) {
  const last = chat[chat.length - 1];
  const lastIsReply = Boolean(last) && !last.is_user && !last.is_system;
  const currentText = (message) => (Array.isArray(message.swipes) && message.swipes.length ? message.swipes[message.swipe_id ?? 0] : message.mes);

  if (result.type === 'continue') {
    if (chat.length === result.messageCount && lastIsReply && typeof last.mes === 'string' && last.mes.length >= result.baseLength) {
      return { kind: 'continue', index: chat.length - 1 };
    }
    return { kind: 'mismatch' };
  }
  if (result.type === 'swipe') {
    if (chat.length === result.messageCount && lastIsReply) {
      return { kind: isPlaceholderOf(currentText(last), result.text) ? 'replaceCurrent' : 'addSwipe', index: chat.length - 1 };
    }
    return { kind: 'mismatch' };
  }
  // normal / regenerate
  if (chat.length === result.messageCount) return { kind: 'append' };
  if (chat.length === result.messageCount + 1 && lastIsReply) {
    return { kind: isPlaceholderOf(currentText(last), result.text) ? 'replaceCurrent' : 'addSwipe', index: chat.length - 1 };
  }
  return { kind: 'mismatch' };
}
