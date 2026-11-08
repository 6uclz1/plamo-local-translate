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
  modelChip: $('model-chip'), modelChipLabel: $('model-chip-label'), modelDot: $('model-dot'),
  sourceLang: $('source-lang'), targetLang: $('target-lang'), swap: $('swap'), formWrap: $('form-wrap'),
  input: $('input'), charCount: $('char-count'), extrasToggle: $('extras-toggle'), extras: $('extras'),
  context: $('context'), glossary: $('glossary'),
  openSettings: $('open-settings'), primary: $('primary'), primaryLabel: $('primary-label'), primaryIcon: $('primary-icon'),
  status: $('status'), progressWrap: $('progress-wrap'), progress: $('progress'),
  resultCard: $('result-card'), resultLang: $('result-lang'), output: $('output'), speed: $('speed'),
  copy: $('copy'), copyIcon: $('copy-icon'),
  sheet: $('model-sheet'), closeSheet: $('close-sheet'), quant: $('quant'), useGpu: $('use-gpu'), gpuNote: $('gpu-note'),
  chunk: $('chunk'), load: $('load'), clearCache: $('clear-cache'),
};
const formRadios = [...document.querySelectorAll('input[name="form"]')];
const langName = new Map([['ja-easy', 'やさしい日本語'], ...LANGS]);

const prefs = {
  get(k, d) { try { return localStorage.getItem('plamo-web:' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('plamo-web:' + k, v); } catch { /* storage unavailable */ } },
};

let wllama = null;
let loading = false;
let abort = null;

// ---------- view state ----------

function fillLangs() {
  const opt = (v, t) => Object.assign(document.createElement('option'), { value: v, textContent: t });
  el.sourceLang.append(opt('', '自動検出'));
  el.targetLang.append(opt('ja-easy', 'やさしい日本語'));
  for (const [code, name] of LANGS) {
    el.sourceLang.append(opt(code, name));
    el.targetLang.append(opt(code, name));
  }
  el.sourceLang.value = prefs.get('source', '');
  el.targetLang.value = prefs.get('target', 'en');
  el.quant.value = prefs.get('quant', el.quant.value);
  el.chunk.value = prefs.get('chunk', el.chunk.value);
  syncLangUi();
}

const formValue = () => formRadios.find((r) => r.checked)?.value || null;

function syncLangUi() {
  const ja = el.targetLang.value === 'ja';
  el.formWrap.hidden = !ja;
  if (!ja) formRadios[0].checked = true;
  // 自動検出 / やさしい日本語 は入れ替えできない
  el.swap.disabled = !el.sourceLang.value || el.targetLang.value === 'ja-easy';
}

function setStatus(msg, kind = '') {
  el.status.textContent = msg;
  el.status.dataset.kind = kind;
}

function setModelState(state, label) {
  el.modelDot.dataset.state = state;
  el.modelChipLabel.textContent = label;
}

/** Primary action: load the model first, then translate; while translating it stops. */
function syncPrimary() {
  let mode;
  if (abort) mode = 'stop';
  else if (loading) mode = 'loading';
  else if (wllama) mode = 'translate';
  else mode = 'load';
  const ui = {
    load: ['モデルを読み込む', '#i-download'],
    loading: ['読み込み中…', '#i-download'],
    translate: ['翻訳する', '#i-arrow-up'],
    stop: ['停止', '#i-stop'],
  }[mode];
  el.primary.dataset.mode = mode;
  el.primaryLabel.textContent = ui[0];
  el.primaryIcon.setAttribute('href', ui[1]);
  el.primary.disabled = mode === 'loading' || (mode === 'translate' && !el.input.value.trim());
  el.load.disabled = loading || !!abort;
}

function updateCharCount() {
  const n = el.input.value.length;
  el.charCount.textContent = n ? `${n.toLocaleString()} 文字` : '';
  syncPrimary();
}

// ---------- model ----------

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
  if (loading || abort) return;
  loading = true;
  syncPrimary();
  el.progressWrap.hidden = false;
  el.progress.removeAttribute('value');
  setModelState('loading', '読み込み中');
  try {
    if (wllama) {
      await wllama.exit();
      wllama = null;
    }
    const w = await createWllama();
    const file = el.quant.value;
    const useGpu = el.useGpu.checked && w.isSupportWebGPU();
    setStatus('モデルを確認しています…');
    await w.loadModelFromUrl(MODEL_REPO + file, {
      n_ctx: N_CTX,
      n_gpu_layers: useGpu ? undefined : 0,
      progressCallback: ({ loaded, total }) => {
        if (!(total > 0)) return;
        if (loaded >= total) {
          // Download (or cache read) is done; llama.cpp now loads the weights.
          el.progress.removeAttribute('value');
          setStatus('モデルを準備しています… (端末によっては数分かかります)');
          return;
        }
        el.progress.max = total;
        el.progress.value = loaded;
        setStatus(`ダウンロード中… ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
      },
    });
    wllama = w;
    prefs.set('quant', file);
    const mode = [
      useGpu ? 'WebGPU' : 'CPU',
      w.isMultithread() ? `${w.getNumThreads()} スレッド` : 'シングルスレッド',
    ].join(' · ');
    setModelState('ready', file.match(/(Q\d\w*)\.gguf$/)?.[1] ?? '準備完了');
    setStatus(`準備ができました (${mode})`, 'ok');
  } catch (e) {
    console.error(e);
    setModelState('error', '読み込み失敗');
    setStatus(`読み込みに失敗しました: ${e?.message ?? e}`, 'error');
  } finally {
    loading = false;
    el.progressWrap.hidden = true;
    syncPrimary();
  }
}

async function clearCache() {
  const w = wllama ?? new Wllama(WASM_PATHS);
  await w.cacheManager.clear();
  setStatus('保存したモデルを削除しました。次回はダウンロードし直します。');
}

// ---------- translation ----------

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
    form: formValue(),
  };
  const maxChars = Math.max(200, Number(el.chunk.value) || 1200);
  const { chunks, trailing } = splitChunks(text, maxChars);
  if (chunks.length === 0) {
    setStatus('翻訳する文章を入力してください。', 'error');
    return;
  }

  abort = new AbortController();
  syncPrimary();
  el.resultCard.hidden = false;
  el.resultLang.textContent = langName.get(opts.targetLang) ?? opts.targetLang;
  el.output.textContent = '';
  el.output.dataset.state = 'working';
  el.speed.textContent = '';
  const history = [];
  let done = '';
  let tokens = 0;
  const t0 = performance.now();
  try {
    for (let i = 0; i < chunks.length; i++) {
      const { lead, body } = chunks[i];
      const prompt = buildPrompt({ ...opts, text: body, history: history.slice(-HISTORY_PAIRS) });
      setStatus(chunks.length > 1 ? `翻訳中… ${i + 1} / ${chunks.length}` : '翻訳中…');
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
        el.output.textContent = done + lead + cleanOutput(out);
        el.speed.textContent = `${(tokens / ((performance.now() - t0) / 1000)).toFixed(1)} tok/s`;
      }
      out = cleanOutput(out);
      done += lead + out;
      if (out.trim()) history.push({ source: body, target: out });
    }
    el.output.textContent = (done + trailing).trim();
    setStatus('');
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
    delete el.output.dataset.state;
    syncPrimary();
  }
}

async function copyResult() {
  const text = el.output.textContent;
  if (!text || !navigator.clipboard) return;
  await navigator.clipboard.writeText(text);
  el.copyIcon.setAttribute('href', '#i-check');
  el.copy.setAttribute('aria-label', 'コピーしました');
  setTimeout(() => {
    el.copyIcon.setAttribute('href', '#i-copy');
    el.copy.setAttribute('aria-label', '翻訳結果をコピー');
  }, 1500);
}

// ---------- wiring ----------

fillLangs();
updateCharCount();
setModelState('idle', 'モデル未読み込み');
if (!('gpu' in navigator)) {
  el.useGpu.checked = false;
  el.useGpu.disabled = true;
  el.gpuNote.textContent = 'このブラウザは WebGPU に対応していません';
}

const openSheet = () => el.sheet.showModal();
el.modelChip.addEventListener('click', openSheet);
el.openSettings.addEventListener('click', openSheet);
el.closeSheet.addEventListener('click', () => el.sheet.close());
el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) el.sheet.close(); }); // tap on backdrop
el.load.addEventListener('click', () => { el.sheet.close(); loadModel(); });
el.clearCache.addEventListener('click', () => clearCache().catch((e) => setStatus(`削除に失敗しました: ${e.message}`, 'error')));
el.chunk.addEventListener('change', () => prefs.set('chunk', el.chunk.value));

el.primary.addEventListener('click', () => {
  if (abort) abort.abort();
  else if (wllama) translate();
  else loadModel();
});
el.copy.addEventListener('click', () => copyResult().catch(() => {}));
el.input.addEventListener('input', updateCharCount);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) translate();
});
el.extrasToggle.addEventListener('click', () => {
  const open = el.extras.hidden;
  el.extras.hidden = !open;
  el.extrasToggle.setAttribute('aria-expanded', String(open));
  if (open) el.context.focus();
});

el.targetLang.addEventListener('change', () => { prefs.set('target', el.targetLang.value); syncLangUi(); });
el.sourceLang.addEventListener('change', () => { prefs.set('source', el.sourceLang.value); syncLangUi(); });
el.swap.addEventListener('click', () => {
  const s = el.sourceLang.value;
  const t = el.targetLang.value;
  if (!s || t === 'ja-easy') return;
  el.sourceLang.value = t;
  el.targetLang.value = s;
  const result = el.output.textContent;
  if (result && !abort) {
    el.input.value = result;
    el.output.textContent = '';
    el.resultCard.hidden = true;
    updateCharCount();
  }
  prefs.set('source', t);
  prefs.set('target', s);
  syncLangUi();
});
