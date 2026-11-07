import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseGlossary, cleanOutput, splitChunks, PfmlError } from '../web/pfml.js';

// Expected strings are the PFML3 examples from the model card (BOS omitted).

test('basic translation prompt', () => {
  assert.equal(
    buildPrompt({ text: '会議は来週の月曜日に変更されました。', targetLang: 'en' }),
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>input<|plamo:msg|>会議は来週の月曜日に変更されました。' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>',
  );
});

test('history with source language', () => {
  assert.equal(
    buildPrompt({
      text: 'オーナーでフィルタリングすることもできます。',
      targetLang: 'en',
      sourceLang: 'ja',
      history: [
        { source: 'プロジェクトの管理画面を開きます。', target: 'Open the project dashboard.' },
        { source: '進行中のタスクがすべて表示されます。', target: 'It lists all active tasks.' },
      ],
    }),
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>プロジェクトの管理画面を開きます。' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Open the project dashboard.' +
      '<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>進行中のタスクがすべて表示されます。' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>It lists all active tasks.' +
      '<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>オーナーでフィルタリングすることもできます。' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>',
  );
});

test('glossary', () => {
  assert.equal(
    buildPrompt({
      text: 'プロジェクトの管理画面を開いてください。',
      targetLang: 'en',
      glossary: parseGlossary('管理画面 => dashboard\n\nプロジェクト => project\n'),
    }),
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>glossary' +
      '<|plamo:index|>管理画面<|plamo:item|>dashboard' +
      '<|plamo:index|>プロジェクト<|plamo:item|>project' +
      '<|plamo:tag|>input<|plamo:msg|>プロジェクトの管理画面を開いてください。' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>',
  );
});

test('context', () => {
  assert.equal(
    buildPrompt({ text: 'かみを切りました。', targetLang: 'en', context: '工作で折り紙を作っています。' }),
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>context<|plamo:msg|>工作で折り紙を作っています。' +
      '<|plamo:tag|>input<|plamo:msg|>かみを切りました。' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>',
  );
});

test('plain form for Japanese', () => {
  assert.equal(
    buildPrompt({ text: 'This system is convenient.', targetLang: 'ja', form: 'plain' }),
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>input<|plamo:msg|>This system is convenient.' +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja' +
      '<|plamo:key|>form<|plamo:val|>plain<|plamo:msg|>',
  );
});

test('rejects invalid input', () => {
  assert.throws(() => buildPrompt({ text: '  ', targetLang: 'en' }), PfmlError);
  assert.throws(() => buildPrompt({ text: 'a<|plamo:tag|>b', targetLang: 'en' }), PfmlError);
  assert.throws(() => buildPrompt({ text: 'x', targetLang: 'EN' }), PfmlError);
  assert.throws(() => buildPrompt({ text: 'x', targetLang: 'en', form: 'plain' }), PfmlError);
  assert.throws(() => parseGlossary('no arrow'), PfmlError);
});

test('cleanOutput strips trailing stop tokens', () => {
  assert.equal(cleanOutput('Hello<|plamo:tag|>'), 'Hello');
  assert.equal(cleanOutput('Hello<|plamo:tag|><|plamo:bos|>'), 'Hello');
  assert.equal(cleanOutput('Hello'), 'Hello');
});

test('splitChunks keeps layout and groups paragraphs', () => {
  const text = '\n\nA1\nA2\n\nB\n\n\nC\n';
  const { chunks, trailing } = splitChunks(text, 6);
  const rebuilt = chunks.map((c) => c.lead + c.body).join('') + trailing;
  assert.equal(rebuilt, text);
  assert.deepEqual(chunks.map((c) => c.body), ['A1\nA2', 'B\n\n\nC']);
  const one = splitChunks('X\n\nY', 1000);
  assert.deepEqual(one.chunks.map((c) => c.body), ['X\n\nY']);
});
