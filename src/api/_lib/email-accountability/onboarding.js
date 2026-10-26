// The onboarding check for a connected mailbox: do its sent replies carry the
// metadata the verifier needs? docs/EMAIL_ACCOUNTABILITY_SCOPE.md 8, item 1.
//
// The adapters read the newest few sent messages (sampleSent). Among those
// whose subject marks a reply, this counts how many name their parent in
// In-Reply-To or References, and, on Outlook, how many carry a reply step in
// conversationIndex. The verdict says which verification path will work.

const REPLY_SUBJECT_RE = /^\s*(re|aw|sv|antw|rif|r)\s*:/i;

const indexSteps = (idx) => {
  if (!idx) return 0;
  const n = Buffer.from(String(idx), "base64").length;
  return n > 22 && (n - 22) % 5 === 0 ? (n - 22) / 5 : 0;
};

export const replyHeaderReport = (provider, messages) => {
  const replies = (messages || []).filter((m) => REPLY_SUBJECT_RE.test(m.subject || ""));
  const withHeader = replies.filter((m) => m.inReplyTo || (m.references || []).length).length;
  const withIndex = provider === "outlook" ? replies.filter((m) => indexSteps(m.conversationIndex) > 0).length : 0;
  let verdict;
  let text;
  if (!replies.length) {
    verdict = "no_replies_in_sample";
    text = "The newest sent messages hold no reply. Send a reply from this mailbox and run the check again.";
  } else if (withHeader === replies.length) {
    verdict = "headers_ok";
    text = "Every sampled reply names its parent message. Replies verify by header.";
  } else if (provider === "outlook" && withIndex === replies.length) {
    verdict = "index_only";
    text = "The replies carry no reply headers, but Outlook's conversation index links each one to its parent. Replies verify by the index.";
  } else {
    verdict = "headers_missing";
    text = "Some replies name no parent message. Those replies stay ambiguous and go to a person to verify.";
  }
  return { provider, sampled: (messages || []).length, replies: replies.length, with_headers: withHeader, with_index: withIndex, verdict, text };
};
