# MUSIC-PLAYER

端末内に保存したローカル音源を再生し、再生履歴を [Last.fm](https://www.last.fm/) へスクロブル送信して、自分の聴取統計を分析・可視化する統合型 **PWA 音楽プレイヤー**です。

ビルド不要の Vanilla JS (ES Modules) 製。iPhone / iPad / Android のホーム画面に追加すれば、ネイティブアプリのように利用できます。

🔗 **公開 URL（GitHub Pages）**: https://utausnskareshi.github.io/music-player/

---

## ✨ 特徴

- **ビルドレス**: バンドラ・トランスパイラ不要。`git clone` して静的サーバで配信するだけ。依存 npm パッケージもありません。
- **オフライン対応 PWA**: Service Worker により 2 回目以降は完全オフラインで起動。
- **iOS バックグラウンド再生**: 常駐 `<audio>` 要素 + MediaSession API でロック画面・ワイヤレスイヤホン操作に対応。
- **自前メタデータパーサ**: 外部ライブラリなしで主要フォーマットのタグ・アートワーク・音声プロパティ（サンプリングレート / ビットレート / コーデック等）を解析。
- **Last.fm 連携**: スクロブル送信 / Now Playing / Love / 8 タブの豊富な統計分析。
- **プライバシー重視**: API キー等は端末内で AES-256-GCM 暗号化して保存。アプリ独自のサーバは存在せず、外部送信は Last.fm 公式 API のみ。

---

## 📱 主な機能

| 画面 | 概要 |
|---|---|
| **▶ 再生** | ジャケット・進捗バー・再生/一時停止・前後移動・シーク。シャッフル / リピート（キュー全体 🔁・単曲 🔂）、Love（♡）、0.5〜2.0 倍速（ピッチ維持可）、曲の詳細情報表示。 |
| **📂 ライブラリ** | ファイル / フォルダからの一括取り込み、検索、並び替え（手動 / タイトル / アーティスト / 再生回数 / Love）、ドラッグ並び替え、再生無効化（🔇）、削除、メタデータ再スキャン。 |
| **📝 リスト** | プレイリストの作成・編集・並び替え・削除。詳細画面から「すべて再生」「シャッフル再生」。 |
| **📊 統計** | Last.fm 連携時に聴取履歴を集計（1 日 1 回 JST 自動更新 + 手動更新）。ダッシュボード / トップ / 比較 / ジャンル / 世界と自分 / 振り返り / 時間 / Loved の 8 タブ。リスニング DNA、ジャンル踏破率、メインストリーム度、タイムトラベル、ヒートマップなど。 |
| **⚙ 設定** | Last.fm 認証、スクロブル / Now Playing の ON/OFF、未送信スクロブルの管理、テーマ、10 バンド EQ・各種エフェクト、データ全削除。 |

> 統計画面は **ダブルバッファリング**を採用。一度取得したデータは次回起動時に瞬時表示し、新データはバックグラウンドで取得します。

---

## 🎵 対応音声フォーマット

`mp3` / `m4a` / `m4b` / `aac` / `mp4` / `flac` / `ogg` / `oga` / `opus` / `wav` / `webm`

（DSD・APE・WMA 等は非対応です。）

---

## 💻 動作環境

- **iOS / iPadOS**: Safari（共有メニュー →「ホーム画面に追加」でスタンドアロン PWA として利用。インストールは Safari 必須）
- **Android**: Chrome 推奨
- **PC**: Chrome / Edge / Firefox / Safari

> 個人開発のため、すべての端末・OS バージョンでの動作保証はできません。

---

## 🚀 セットアップ

### ローカルで動かす

ES Modules / Service Worker を使うため、`file://` では動作しません。任意の静的 HTTP サーバで配信してください。

```bash
# 例: Node (http-server)
npx http-server . -p 8765 -c-1

# 例: Python
python -m http.server 8765
```

→ ブラウザで `http://localhost:8765/` を開きます。

### Last.fm 連携の設定

1. Last.fm アカウントでログインし、[API アカウントを作成](https://www.last.fm/api/account/create)して **API キー（32 桁の 16 進）** と **シークレット** を取得します（無料）。発行済みアプリは [API Accounts](https://www.last.fm/api/accounts) で確認できます。
2. アプリの **⚙ 設定 → Last.fm 連携** で、いずれかを選択します。
   - **フル認証（推奨）**: API キー + シークレットを入力 → 認可ページで承認 →「認可済みを反映」。スクロブル送信・Now Playing・Love・統計取得がすべて利用可能。
   - **読取専用**: API キー + ユーザ名のみ。統計・Now Playing 表示は可能ですが、スクロブル送信・Love はできません。

> 🔒 Last.fm の**ユーザ名・パスワードを本アプリに入力することはありません**。認可は Last.fm 公式ページ上で直接行われ、本アプリにはセッションキーのみが渡されます。

---

## 🛠 技術スタック / アーキテクチャ

- **言語/構成**: Vanilla JavaScript (ES Modules)、ビルドツールなし
- **PWA**: Web App Manifest + Service Worker（静的アセットは Cache-First、Last.fm API は Network-First）
- **ストレージ**: IndexedDB（ライブラリ / 再生キュー / 統計 / 設定）、Web Crypto API（AES-256-GCM）
- **音声**: 常駐 `HTMLAudioElement` + MediaSession API、Web Audio API（10 バンド EQ・各種エフェクト ※iOS は既定 OFF）
- **統計集計**: Web Worker（JST 基準で集計）+ ダブルバッファリング
- **グラフ**: [Chart.js](https://www.chartjs.org/) 4.4.4（CDN 参照 / MIT License）
- **外部 API**: Last.fm API（読み取りは GET・署名なし、書き込みは MD5 署名付き POST）

### ディレクトリ構成

```
music-player/
├── index.html            # エントリ HTML
├── manifest.json         # PWA マニフェスト
├── sw.js                 # Service Worker（キャッシュ戦略・バージョン管理）
├── .nojekyll             # GitHub Pages 用（Jekyll 無効化）
├── LICENSE               # MIT
├── css/                  # theme / layout / views
├── icons/                # PWA / favicon / apple-touch アイコン
├── js/
│   ├── app.js            # 起動・初期化
│   ├── router.js         # ハッシュルーター
│   ├── state.js          # アプリ状態（pub/sub）
│   ├── store/            # IndexedDB + 暗号化（crypto / library-db / queue-db / settings）
│   ├── player/           # audio-engine / eq / visualizer
│   ├── metadata/         # 自前パーサ（mp3 / m4a / flac / ogg / wav / webm + lyrics）
│   ├── lastfm/           # api / auth / scrobble / stats（取得・集計・キャッシュ）
│   ├── workers/          # 統計集計 Web Worker
│   └── ui/               # 各画面ビュー + ミニプレイヤー
└── tests/                # Node 単体テスト（.mjs）
```

---

## 🧪 開発・テスト

ロジックの単体テストは依存パッケージなしで Node 単体で実行できます。

```bash
# 個別実行
node tests/test-pure-logic.mjs

# 全テスト（bash）
for f in tests/*.mjs; do node "$f"; done
```

```powershell
# 全テスト（PowerShell）
Get-ChildItem tests/*.mjs | ForEach-Object { node $_.FullName }
```

> アプリ本体は静的配信のみで動作します（`npm install` 不要）。

---

## 🔐 プライバシー / セキュリティ

- API キー / シークレット / セッションキーは IndexedDB に **AES-256-GCM** で暗号化保存します（鍵は端末固有情報から PBKDF2 で導出）。
- 音源ファイルは端末内 IndexedDB にのみ保存されます。**アプリ運営者のサーバは存在せず**、通信は Last.fm 公式 API とアートワーク CDN（統計画面）に限られます。
- リポジトリには API キー等の機密情報は含まれていません（ユーザが各自のキーを実行時に入力します）。

---

## ⚠️ 既知の制限（抜粋）

詳細はアプリ内の **⚙ 設定 → ⚠ 制限事項・既知の問題** に記載しています。代表的なもの:

- **iPhone**: 「オーディオ詳細 / イコライザ」を有効化すると、AudioContext を音声経路に挟むためバックグラウンド再生・ロック画面制御が停止します。iOS では**既定の OFF のまま**使用してください。
- **iOS のストレージ自動削除**: 容量逼迫時に PWA の IndexedDB が削除されることがあります。定期的にアプリを開くと予防できます。
- **統計の初回取得**: 長期間のユーザは全 scrobble 履歴の取得に数分〜十数分かかる場合があります（以降はダブルバッファで瞬時表示）。
- **エクスポート機能は未実装**: 重要なデータは別途バックアップを推奨します。

---

## 📄 ライセンス

[MIT License](LICENSE) © 2026 歌うＬＩＮＥ彼氏

本アプリは Last.fm の公式 API を利用していますが、Last.fm 社とは無関係の非公式アプリです。Last.fm および各社サービス名は各権利者の商標です。Chart.js は MIT License で配布されています。
