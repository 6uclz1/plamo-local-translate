// PFML3 prompt construction for PLaMo 3 Translate.
// Mirrors the element order of the model's chat template:
// dataset -> context -> history (input/output pairs) -> glossary -> input -> output.
// The BOS token is not included: llama.cpp adds it automatically.

export const RESERVED = '<|plamo:';
export const STOP_STRINGS = ['<|plamo:tag|>', '<|plamo:bos|>'];

const T = {
  tag: '<|plamo:tag|>',
  msg: '<|plamo:msg|>',
  key: '<|plamo:key|>',
  val: '<|plamo:val|>',
  index: '<|plamo:index|>',
  item: '<|plamo:item|>',
};

const LANG_RE = /^[a-z]{2,3}(-[a-z]{4})?$/;

export class PfmlError extends Error {}

function checkText(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new PfmlError(`${name} must be a string.`);
  if (!allowEmpty && value.trim() === '') throw new PfmlError(`${name} must not be empty.`);
  if (value.includes(RESERVED)) {
    throw new PfmlError(`${name} must not contain reserved PFML tokens (${RESERVED}...).`);
  }
}

function checkLang(value, name) {
  if (typeof value !== 'string' || !LANG_RE.test(value)) {
    throw new PfmlError(`${name} must be a lowercase language code, e.g. en, ja, zh-hans or ja-easy.`);
  }
}

const langAttr = (lang) => (lang ? `${T.key}lang${T.val}${lang}` : '');

/**
 * @param {object} p
 * @param {string} p.text source text to translate
 * @param {string} p.targetLang
 * @param {string|null} [p.sourceLang]
 * @param {string|null} [p.context] reference text
 * @param {{source: string, target: string}[]} [p.glossary]
 * @param {'polite'|'plain'|null} [p.form] Japanese output style; requires targetLang "ja"
 * @param {{source: string, target: string}[]} [p.history] already translated pairs
 */
export function buildPrompt({ text, targetLang, sourceLang = null, context = null, glossary = [], form = null, history = [] }) {
  checkText(text, 'text');
  checkLang(targetLang, 'targetLang');
  if (sourceLang) checkLang(sourceLang, 'sourceLang');
  if (context) checkText(context, 'context', { allowEmpty: true });
  if (form) {
    if (form !== 'polite' && form !== 'plain') throw new PfmlError('form must be polite or plain.');
    if (targetLang !== 'ja') throw new PfmlError('form requires targetLang "ja".');
  }
  for (const g of glossary) {
    checkText(g.source, 'glossary source');
    checkText(g.target, 'glossary target');
  }
  for (const h of history) {
    checkText(h.source, 'history source');
    checkText(h.target, 'history target');
  }

  let p = `${T.tag}dataset${T.msg}translation`;
  if (context) p += `${T.tag}context${T.msg}${context}`;
  for (const h of history) {
    p += `${T.tag}input${langAttr(sourceLang)}${T.msg}${h.source}`;
    p += `${T.tag}output${langAttr(targetLang)}${T.msg}${h.target}`;
  }
  if (glossary.length > 0) {
    p += `${T.tag}glossary`;
    for (const g of glossary) p += `${T.index}${g.source}${T.item}${g.target}`;
  }
  p += `${T.tag}input${langAttr(sourceLang)}${T.msg}${text}`;
  p += `${T.tag}output${langAttr(targetLang)}`;
  if (form) p += `${T.key}form${T.val}${form}`;
  p += T.msg;
  return p;
}

/** Parse "source => target" lines. Blank lines are ignored; malformed lines throw. */
export function parseGlossary(src) {
  const out = [];
  src.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parts = line.split('=>');
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      throw new PfmlError(`Glossary line ${i + 1} must be "source => target": ${line}`);
    }
    out.push({ source: parts[0].trim(), target: parts[1].trim() });
  });
  return out;
}

/** Remove trailing stop tokens if the runtime left them in the text. */
export function cleanOutput(text) {
  let t = text;
  for (;;) {
    const s = STOP_STRINGS.find((x) => t.endsWith(x));
    if (!s) return t;
    t = t.slice(0, -s.length);
  }
}

/**
 * Split text into chunks of whole paragraphs (separated by blank lines),
 * each at most maxChars unless a single paragraph is longer.
 * Returns [{ lead, body }] where lead is the whitespace before body, so
 * joining lead + translated body reproduces the layout.
 */
export function splitChunks(text, maxChars = 1200) {
  const lead0 = text.match(/^\s*/)[0];
  const rest = text.slice(lead0.length);
  const trailing = rest.match(/\s*$/)[0];
  const core = rest.slice(0, rest.length - trailing.length);
  if (!core) return { chunks: [], trailing: text };
  const parts = core.split(/(\s*\n\s*\n\s*)/);
  const chunks = [];
  let cur = { lead: lead0, body: parts[0] };
  for (let i = 1; i < parts.length; i += 2) {
    const sep = parts[i];
    const para = parts[i + 1];
    if (cur.body.length + sep.length + para.length > maxChars) {
      chunks.push(cur);
      cur = { lead: sep, body: para };
    } else {
      cur.body += sep + para;
    }
  }
  chunks.push(cur);
  return { chunks, trailing };
}
