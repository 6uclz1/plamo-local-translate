# plamo-local-translate

> 個人による非公式プロジェクトです。Preferred Networks とは関係ありません。

[PLaMo 3 Translate 0.8B](https://huggingface.co/pfnet/plamo-3-translate-0.8b) をブラウザ内で動かす翻訳サイトです。
推論は [wllama](https://github.com/ngxson/wllama) (llama.cpp の WebAssembly ビルド) で行い、WebGPU が使えるブラウザでは GPU を使います。
入力したテキストは外部に送信されません。

- モデル: 公式 GGUF ([pfnet/plamo-3-translate-0.8b-GGUF](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF)) を Hugging Face から直接ダウンロードし、ブラウザのキャッシュに保存します。リポジトリには含めません。
- プロンプト: モデルカード推奨の PFML3 形式を `web/pfml.js` で組み立てます (翻訳元・翻訳先言語、です/だ調、コンテキスト、用語集、翻訳履歴)。
- 長文: 空行区切りの段落を指定文字数ごとにまとめて順に翻訳し、直前の訳を履歴として渡します。

## 通信とプライバシー

外部との通信は **モデルファイルのダウンロードだけ** です。翻訳 (推論) はすべてブラウザ内で完結します。

- `index.html` の Content-Security-Policy で `default-src 'none'` とし、通信先をこのサイト自身と
  `https://huggingface.co` / `https://*.hf.co` (モデル配布元とそのダウンロード CDN) に限定しています。
  スクリプトのバグや改変があっても、入力テキストを他のホストへ送ることはブラウザが拒否します。
- モデルのダウンロード要求に含まれるのはファイルの URL だけで、入力テキストは含まれません。
  `no-referrer` により、どのサイトから来たかも送りません。
- ダウンロード済みのモデルはブラウザ内 (Cache Storage) に保存し、次回からは Hugging Face に一切接続せずに読み込みます。
- 外部 CDN・Web フォント・アクセス解析は使っていません。wllama の互換ビルドも CDN ではなく本サイトから配信します。
- 端末に保存するのはモデルと言語設定だけで、入力テキストや翻訳結果は保存しません。
- ページ自体の配信元 (GitHub Pages) には、通常の Web サイトと同様にアクセスログ (IP アドレスなど) が残ります。

この方針は `tests/privacy.test.mjs` で検査しています。

## なぜ wllama をソースからビルドするのか

npm 公開版の wllama (3.8.1) に含まれる llama.cpp は PLaMo 3 のトークナイザに対応しておらず、
`unknown tokenizer: 'plamo3'` で失敗します。そのため `scripts/build-wllama.sh` で
固定コミットの wllama (llama.cpp 2026-11-05 版を同梱) をビルドし、`web/vendor/wllama/` に配置します。
GitHub Actions では結果をキャッシュします。

## 公開 (GitHub Pages)

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする。
2. `main` に push すると `.github/workflows/pages.yml` がテスト → wllama ビルド → デプロイを行う。

## ローカル開発

```bash
npm test                      # PFML3 プロンプト生成のテスト
bash scripts/build-wllama.sh  # docker と Node.js 22 が必要 (初回は数十分)
npm run serve                 # http://127.0.0.1:8080/
```

## 制約

- GitHub Pages では COOP/COEP ヘッダを設定できないため、CPU 推論はシングルスレッドです。WebGPU 対応ブラウザ (Chrome / Edge など) での利用を推奨します。
- Safari など JSPI / Memory64 非対応のブラウザでは、互換ビルド (Asyncify) を自動で使います。速度は落ちます。
- モデルのダウンロードは初回 400〜570 MB です。

## ライセンス

- サイトのコード: 本リポジトリのライセンスに従います。
- モデル: [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja)。個人・非商用利用は無償です。商用利用の条件はライセンス本文を確認してください。
- wllama / llama.cpp: MIT License。

Built with PLaMo
