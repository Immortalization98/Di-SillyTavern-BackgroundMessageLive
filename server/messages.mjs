// Push notification texts. They never contain chat content, character names or anything else
// from the conversation — only a fixed sentence, so a locked screen reveals nothing.

export const LANGUAGES = Object.freeze(['en', 'zh']);

const TEXT = Object.freeze({
  en: Object.freeze({
    test: 'Test notification: push notifications are working.',
    done: 'A reply is ready. Open SillyTavern to see it.',
    failed: 'A reply could not be finished. Open SillyTavern to try again.',
  }),
  zh: Object.freeze({
    test: '测试通知：推送已经打通。',
    done: '有一条回复已生成，回到酒馆就能看到。',
    failed: '有一条回复没能生成完成，回到酒馆可以重试。',
  }),
});

/** Maps any locale string ("zh-cn", "zh-TW", "en-US", …) to a supported notification language. */
export function notificationLanguage(locale) {
  return /^zh/i.test(String(locale ?? '')) ? 'zh' : 'en';
}

/** kind: 'test' | 'done' | 'failed' */
export function buildNotification(kind, language, { title = 'SillyTavern' } = {}) {
  const text = TEXT[notificationLanguage(language)];
  if (!(kind in text)) throw new Error(`unknown notification kind: ${kind}`);
  return { title, body: text[kind], tag: kind === 'test' ? 'bgml-test' : 'bgml-done', url: '/' };
}
