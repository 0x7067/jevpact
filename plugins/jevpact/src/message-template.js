const MAX_RECENT = 10;
const MAX_RENDERED_CHARS = 20_000;
const MAX_SINGLE_TEXT = 4_000;
const MAX_LIST_TEXT = 1_200;
const MAX_TOOL_INPUT = 500;

export const MESSAGE_TOKENS = Object.freeze([
  { token: 'user.latestPrompt', description: 'Latest direct user prompt or answer.' },
  { token: 'user.recentPrompts:N', description: 'Last N direct user prompts or answers, oldest first (N: 1-10).' },
  { token: 'assistant.latestMessage', description: 'Latest visible assistant commentary or final message.' },
  { token: 'assistant.latestFinal', description: 'Latest visible assistant final message.' },
  { token: 'assistant.recentMessages:N', description: 'Last N visible assistant messages, oldest first (N: 1-10).' },
  { token: 'work.latestDirection', description: 'Latest external direction, including a delegated or scheduled direction.' },
  { token: 'pause.wrapUp', description: 'Assistant final wrap-up after a pause request; unavailable in the pause message.' },
  { token: 'assistant.lastBeforeCompaction', description: 'Last visible assistant message frozen immediately before native compaction; available on resume.' },
  { token: 'tools.recentCalls:N', description: 'Last N observed tool calls with bounded input and result-observation state (N: 1-10).' },
  { token: 'tools.pendingCalls', description: 'Recent tool calls for which no result has been observed.' },
  { token: 'tools.lastResult', description: 'Bounded text excerpt of the latest observed tool result.' },
  { token: 'lifecycle.phase', description: 'pause, resume, or defer.' },
  { token: 'lifecycle.reason', description: 'Reason for this lifecycle message.' },
  { token: 'lifecycle.trigger', description: 'Checkpoint kind that began this lifecycle.' },
  { token: 'context.inputTokens', description: 'Observed input tokens at the checkpoint.' },
  { token: 'context.windowTokens', description: 'Codex-reported context window at the checkpoint.' },
  { token: 'context.recentGrowthTokens', description: 'Recent observed context growth at the checkpoint.' },
  { token: 'context.requestsSinceCompaction', description: 'Model requests since the prior compaction at the checkpoint.' },
  { token: 'compaction.generation', description: 'Observed native compaction count for this task.' },
  { token: 'thread.id', description: 'Native Codex task ID.' },
  { token: 'project.root', description: 'Main Git checkout root or current working directory.' },
  { token: 'profile.name', description: 'Most specific applied configuration profile.' },
]);

const recentTokens = new Set(['user.recentPrompts', 'assistant.recentMessages', 'tools.recentCalls']);
const simpleTokens = new Set(MESSAGE_TOKENS.filter(item => !item.token.endsWith(':N')).map(item => item.token));

function parseToken(raw) {
  const value = raw.trim();
  if (value === 'compaction.recordText') throw new Error('compaction.recordText is unavailable: native compaction content is encrypted');
  const match = /^([A-Za-z][A-Za-z0-9.]*)(?::([1-9][0-9]*))?$/.exec(value);
  if (!match) throw new Error(`invalid message token ${JSON.stringify(value)}`);
  const [, name, requested] = match;
  if (recentTokens.has(name)) {
    const count = requested == null ? 3 : Number(requested);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RECENT) throw new Error(`${name} count must be 1-${MAX_RECENT}`);
    return { name, count, label: value };
  }
  if (requested != null || !simpleTokens.has(name)) throw new Error(`unknown message token ${JSON.stringify(value)}`);
  return { name, label: value };
}

function parseTemplate(template) {
  const parts = [];
  let offset = 0;
  while (offset < template.length) {
    const open = template.indexOf('{{', offset);
    if (open < 0) { parts.push({ text: template.slice(offset) }); break; }
    if (open > 0 && template[open - 1] === '\\') {
      parts.push({ text: template.slice(offset, open - 1) + '{{' });
      offset = open + 2;
      continue;
    }
    parts.push({ text: template.slice(offset, open) });
    const close = template.indexOf('}}', open + 2);
    if (close < 0 || template.slice(open + 2, close).includes('{{')) throw new Error('unclosed message token');
    parts.push({ token: parseToken(template.slice(open + 2, close)) });
    offset = close + 2;
  }
  return parts;
}

export function validateMessageTemplate(template) {
  parseTemplate(template);
  return template;
}

function clipped(value, limit) {
  const text = String(value);
  if (text.length <= limit) return text;
  const suffix = ' [truncated]';
  if (limit <= suffix.length) return text.slice(0, Math.max(0, limit));
  return text.slice(0, Math.max(0, limit - suffix.length)) + suffix;
}

function available(value, name, limit = MAX_SINGLE_TEXT) {
  return value == null || value === '' ? `[unavailable: ${name}]` : clipped(value, limit);
}

function listed(values, name, format, requested = null) {
  if (!values.length) return `[unavailable: ${name}]`;
  const short = requested != null && values.length < requested ? `[${values.length} of ${requested} available]\n` : '';
  return short + values.map((value, index) => `${index + 1}. ${format(value)}`).join('\n');
}

function tokenValue(token, context) {
  const { name, count = 3 } = token;
  const { snapshot = {}, phase, reason, trigger, pauseWrapUp, lastBeforeCompaction,
    projectRoot, profileName, compactionGeneration } = context;
  const directPrompts = (snapshot.recentUserRequests ?? []).filter(item => ['ordinary', 'answer'].includes(item.origin));
  const messages = (snapshot.messages ?? []).filter(item => item.role === 'assistant');
  const calls = snapshot.toolCalls ?? [];
  const number = value => available(value, name);
  switch (name) {
    case 'user.latestPrompt': {
      const prompt = directPrompts.at(-1);
      return available(prompt?.text && `${prompt.text}${prompt.truncated ? ' [truncated]' : ''}`, name);
    }
    case 'user.recentPrompts': return listed(directPrompts.slice(-count), name,
      item => JSON.stringify(clipped(`${item.text}${item.truncated ? ' [truncated]' : ''}`, MAX_LIST_TEXT)), count);
    case 'assistant.latestMessage': return available(messages.at(-1)?.text, name);
    case 'assistant.latestFinal': {
      const final = snapshot.recentFinalReports?.at(-1);
      return available(final?.text ? `${final.text}${final.truncated ? ' [truncated]' : ''}`
        : messages.findLast(item => ['final', 'final_answer'].includes(item.phase))?.text, name);
    }
    case 'assistant.recentMessages': return listed(messages.slice(-count), name,
      item => `[${item.phase ?? 'message'}] ${JSON.stringify(clipped(item.text, MAX_LIST_TEXT))}`, count);
    case 'work.latestDirection': return available(snapshot.latestUserDirection?.text, name);
    case 'pause.wrapUp': return available(pauseWrapUp, name);
    case 'assistant.lastBeforeCompaction': return available(lastBeforeCompaction, name);
    case 'tools.recentCalls': return listed(calls.slice(-count), name, item =>
      `${item.namespace ? `${item.namespace}.` : ''}${item.name} (${item.resultObserved ? 'result observed' : 'result not observed'})`+
      `${item.input ? ` input=${JSON.stringify(clipped(`${item.input}${item.inputTruncated ? ' [truncated]' : ''}`, MAX_TOOL_INPUT))}` : ''}`, count);
    case 'tools.pendingCalls': return listed(calls.filter(item => !item.resultObserved).slice(-MAX_RECENT), name,
      item => `${item.namespace ? `${item.namespace}.` : ''}${item.name} (result not observed)`);
    case 'tools.lastResult': {
      const result = snapshot.lastToolResult;
      return result?.text ? `${result.name ?? 'tool'} output excerpt: ${JSON.stringify(clipped(
        `${result.text}${result.truncated ? ' [truncated]' : ''}`, MAX_SINGLE_TEXT))}`
        : `[unavailable: ${name}]`;
    }
    case 'lifecycle.phase': return available(phase, name);
    case 'lifecycle.reason': return available(reason, name);
    case 'lifecycle.trigger': return available(trigger, name);
    case 'context.inputTokens': return number(snapshot.usage?.inputTokens ?? snapshot.inputTokens);
    case 'context.windowTokens': return number(snapshot.usage?.contextWindow ?? snapshot.modelContextWindow);
    case 'context.recentGrowthTokens': return number(snapshot.usage?.recentGrowthTokens ?? snapshot.recentGrowthTokens);
    case 'context.requestsSinceCompaction': return number(snapshot.requestsSinceCompaction);
    case 'compaction.generation': return number(compactionGeneration ?? snapshot.compactionGeneration);
    case 'thread.id': return available(snapshot.sessionId, name);
    case 'project.root': return available(projectRoot, name);
    case 'profile.name': return available(profileName, name);
    default: throw new Error(`unknown message token ${JSON.stringify(name)}`);
  }
}

export function renderMessageTemplate(template, context) {
  const parts = parseTemplate(template);
  const staticLength = parts.reduce((size, part) => size + (part.text?.length ?? 0), 0);
  let remaining = MAX_RENDERED_CHARS - staticLength;
  return parts.map(part => {
    if (part.text != null) return part.text;
    const value = tokenValue(part.token, context);
    if (value.length <= remaining) { remaining -= value.length; return value; }
    if (remaining <= 0) return '';
    const rendered = clipped(value, remaining);
    remaining = 0;
    return rendered;
  }).join('');
}
