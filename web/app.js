import { Wllama } from './vendor/wllama/index.js';
import { buildPrompt, parseGlossary, cleanOutput, splitChunks, STOP_STRINGS, PfmlError } from './pfml.js';

// The only remote resource: the model weights. Everything else is served by this site,
// and index.html's Content-Security-Policy blocks any other connection.
const MODEL_REPO = 'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/main/';
const WASM_PATHS = { default: new URL('./vendor/wllama/wllama.wasm', import.meta.url).href };
const N_CTX = 8192;
const HISTORY_PAIRS = 2;

// Language codes from the model card (53 languages), plus ja-easy (やさしい日本語).
const LANGS = [
  ['ja', '日本語'], ['en', '英語'], ['zh-hans', '中国語 (簡体字)'], ['zh-hant', '中国語 (繁体字)'],
  ['ko', '韓国語'], ['ar', 'アラビア語'], ['az', 'アゼルバイジャン語'], ['be', 'ベラルーシ語'],
  ['bg', 'ブルガリア語'], ['bn', 'ベンガル語'], ['ca', 'カタルーニャ語'], ['ceb', 'セブアノ語'],
  ['de', 'ドイツ語'], ['es', 'スペイン語'], ['et', 'エストニア語'], ['eu', 'バスク語'],
  ['fa', 'ペルシア語'], ['fr', 'フランス語'], ['gu', 'グジャラート語'], ['he', 'ヘブライ語'],
  ['hi', 'ヒンディー語'], ['hr', 'クロアチア語'], ['hu', 'ハンガリー語'], ['hy', 'アルメニア語'],
  ['id', 'インドネシア語'], ['it', 'イタリア語'], ['jv', 'ジャワ語'], ['ka', 'ジョージア語'],
  ['kk', 'カザフ語'], ['km', 'クメール語'], ['lt', 'リトアニア語'], ['lv', 'ラトビア語'],
  ['ml', 'マラヤーラム語'], ['mr', 'マラーティー語'], ['ms', 'マレー語'], ['my', 'ビルマ語'],
  ['ne', 'ネパール語'], ['nl', 'オランダ語'], ['pa', 'パンジャーブ語'], ['pl', 'ポーランド語'],
  ['ru', 'ロシア語'], ['si', 'シンハラ語'], ['sk', 'スロバキア語'], ['sl', 'スロベニア語'],
  ['sr', 'セルビア語'], ['sw', 'スワヒリ語'], ['ta', 'タミル語'], ['te', 'テルグ語'],
  ['th', 'タイ語'], ['tl', 'タガログ語'], ['ur', 'ウルドゥー語'], ['uz', 'ウズベク語'],
  ['vi', 'ベトナム語'],
];

const $ = (id) => document.getElementById(id);
const el = {
  quant: $('quant'), useGpu: $('use-gpu'), load: $('load'), clearCache: $('clear-cache'),
  progress: $('progress'), status: $('status'), sourceLang: $('source-lang'), targetLang: $('target-lang'),
  swap: $('swap'), form: $('form'), formWrap: $('form-wrap'), input: $('input'), output: $('output'),
  translate: $('translate'), stop: $('stop'), copy: $('copy'), speed: $('speed'),
  context: $('context'), glossary: $('glossary'), chunk: $('chunk'),
};

const prefs = {
  get(k, d) { try { return localStorage.getItem('plamo-web:' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('plamo-web:' + k, v); } catch { /* storage unavailable */ } },
};

function fillLangs() {
  const opt = (v, t) => Object.assign(document.createElement('option'), { value: v, textContent: t });
  el.sourceLang.append(opt('', '自動 (指定なし)'));
  el.targetLang.append(opt('ja-easy', 'やさしい日本語'));
  for (const [code, name] of LANGS) {
    el.sourceLang.append(opt(code, name));
    el.targetLang.append(opt(code, name));
  }
  el.sourceLang.value = prefs.get('source', '');
  el.targetLang.value = prefs.get('target', 'en');
  el.quant.value = prefs.get('quant', el.quant.value);
  updateFormVisibility();
}

function updateFormVisibility() {
  const ja = el.targetLang.value === 'ja';
  el.formWrap.hidden = !ja;
  if (!ja) el.form.value = '';
}

function setStatus(msg, kind = '') {
  el.status.textContent = msg;
  el.status.dataset.kind = kind;
}

let wllama = null;
let loading = false;
let abort = null;

async function createWllama() {
  const w = new Wllama(WASM_PATHS, { allowOffline: true });
  // Browsers without JSPI / Memory64 (e.g. Safari) use the Asyncify build, self-hosted here.
  const workerCode = await (await fetch(new URL('./vendor/wllama/compat/wllama.js', import.meta.url))).text();
  w.setCompat({
    wasm: new URL('./vendor/wllama/compat/wllama.wasm', import.meta.url).href,
    worker: { code: workerCode },
  });
  return w;
}

async function loadModel() {
  if (loading) return;
  loading = true;
  el.load.disabled = true;
  el.translate.disabled = true;
  el.progress.hidden = false;
  el.progress.removeAttribute('value');
  try {
    if (wllama) {
      await wllama.exit();
      wllama = null;
    }
    const w = await createWllama();
    const file = el.quant.value;
    const useGpu = el.useGpu.checked && w.isSupportWebGPU();
    setStatus(`${file} をダウンロード中…`);
    await w.loadModelFromUrl(MODEL_REPO + file, {
      n_ctx: N_CTX,
      n_gpu_layers: useGpu ? undefined : 0,
      progressCallback: ({ loaded, total }) => {
        if (total > 0) {
          el.progress.max = total;
          el.progress.value = loaded;
          setStatus(`ダウンロード中… ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
        }
      },
    });
    wllama = w;
    prefs.set('quant', file);
    const mode = [
      useGpu ? 'WebGPU' : 'CPU',
      w.isMultithread() ? `${w.getNumThreads()} スレッド` : 'シングルスレッド',
    ].join(' / ');
    setStatus(`読み込み完了: ${file} (${mode})`, 'ok');
    el.translate.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus(`読み込みに失敗しました: ${e?.message ?? e}`, 'error');
  } finally {
    loading = false;
    el.load.disabled = false;
    el.progress.hidden = true;
  }
}

async function translate() {
  if (!wllama || abort) return;
  const text = el.input.value;
  let glossary;
  try {
    glossary = parseGlossary(el.glossary.value);
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }
  const opts = {
    targetLang: el.targetLang.value,
    sourceLang: el.sourceLang.value || null,
    context: el.context.value.trim() ? el.context.value : null,
    glossary,
    form: el.form.value || null,
  };
  const maxChars = Math.max(200, Number(el.chunk.value) || 1200);
  const { chunks, trailing } = splitChunks(text, maxChars);
  if (chunks.length === 0) {
    setStatus('翻訳するテキストを入力してください。', 'error');
    return;
  }

  abort = new AbortController();
  el.translate.disabled = true;
  el.stop.disabled = false;
  el.output.value = '';
  const history = [];
  let done = '';
  let tokens = 0;
  const t0 = performance.now();
  try {
    for (let i = 0; i < chunks.length; i++) {
      const { lead, body } = chunks[i];
      const prompt = buildPrompt({ ...opts, text: body, history: history.slice(-HISTORY_PAIRS) });
      setStatus(chunks.length > 1 ? `翻訳中… (${i + 1} / ${chunks.length})` : '翻訳中…');
      let out = '';
      const stream = await wllama.createCompletion({
        prompt,
        stream: true,
        max_tokens: Math.min(4096, body.length * 2 + 128),
        temperature: 0,
        stop: STOP_STRINGS,
        abortSignal: abort.signal,
      });
      for await (const chunk of stream) {
        out += chunk.choices?.[0]?.text ?? '';
        tokens++;
        el.output.value = done + lead + cleanOutput(out);
        el.speed.textContent = `${(tokens / ((performance.now() - t0) / 1000)).toFixed(1)} tok/s`;
      }
      out = cleanOutput(out);
      done += lead + out;
      if (out.trim()) history.push({ source: body, target: out });
    }
    el.output.value = done + trailing;
    setStatus('完了', 'ok');
  } catch (e) {
    if (abort.signal.aborted) {
      setStatus('停止しました。');
    } else if (e instanceof PfmlError) {
      setStatus(e.message, 'error');
    } else {
      console.error(e);
      setStatus(`翻訳に失敗しました: ${e?.message ?? e}`, 'error');
    }
  } finally {
    abort = null;
    el.translate.disabled = !wllama;
    el.stop.disabled = true;
  }
}

async function clearCache() {
  const w = wllama ?? new Wllama(WASM_PATHS);
  await w.cacheManager.clear();
  setStatus('キャッシュしたモデルを削除しました。次回はダウンロードし直します。');
}

fillLangs();
if (!('gpu' in navigator)) {
  el.useGpu.checked = false;
  el.useGpu.disabled = true;
  el.useGpu.parentElement.title = 'このブラウザは WebGPU に対応していません';
}
el.load.addEventListener('click', loadModel);
el.clearCache.addEventListener('click', () => clearCache().catch((e) => setStatus(`削除に失敗しました: ${e.message}`, 'error')));
el.translate.addEventListener('click', translate);
el.stop.addEventListener('click', () => abort?.abort());
el.copy.addEventListener('click', () => navigator.clipboard?.writeText(el.output.value));
el.targetLang.addEventListener('change', () => { prefs.set('target', el.targetLang.value); updateFormVisibility(); });
el.sourceLang.addEventListener('change', () => prefs.set('source', el.sourceLang.value));
el.swap.addEventListener('click', () => {
  const s = el.sourceLang.value;
  const t = el.targetLang.value;
  if (!s || t === 'ja-easy') return; // 自動 / やさしい日本語 は入れ替え不可
  el.sourceLang.value = t;
  el.targetLang.value = s;
  if (el.output.value) [el.input.value, el.output.value] = [el.output.value, ''];
  prefs.set('source', t);
  prefs.set('target', s);
  updateFormVisibility();
});
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) translate();
});
