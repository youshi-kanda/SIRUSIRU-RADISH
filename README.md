# SIRUSIRU Cloudflare Pages デプロイ用フォルダ

このフォルダには、Cloudflare Pagesにデプロイするファイルのみが含まれています。

## 📁 ファイル構成

### メインアプリケーション
- **`index.html`** - メインHTMLファイル（チャットUI・複数ファイルアップロード対応）
- **`script.js`** - メインJavaScript（チャット機能・自動チャージ通知）
- **`style.css`** - スタイルシート（通知アニメーション含む）
- **`quota-integration.js`** - クォータ管理機能

### Cloudflare Workers
- **`workers_final_complete.js`** - Cloudflare Workers用スクリプト（別途デプロイ）

### 辞書管理ツール
- **`dictionary-manager.html`** - ブランド名音声辞書管理ツール
- **`brand-dictionary.js`** - 辞書設定ファイル
- **`brand-dictionary.json`** - 辞書データ（エクスポート/インポート用）

## 🚀 デプロイ方法

### Cloudflare Pages へのデプロイ

1. **Cloudflare Pages プロジェクト作成**
   ```bash
   # このフォルダをルートディレクトリとして指定
   D:\_Creator\ayvance\kawai\Dify\sirusiru-noce\pages
   ```

2. **ビルド設定**
   - ビルドコマンド: なし（静的ファイルのみ）
   - ビルド出力ディレクトリ: `/`

3. **環境変数設定**
   - 特に必要なし（Workers側で設定）

### Cloudflare Workers へのデプロイ

1. **Workers スクリプト**
   ```bash
   # workers_final_complete.js を Cloudflare Workers にデプロイ
   wrangler deploy workers_final_complete.js
   ```

2. **環境変数設定**
   - `DIFY_API_KEY`
   - `GCP_API_KEY`
   - `TENANT_API_BASE`
   - `DIFY_BASE`

## 📝 辞書管理

### ブランド名辞書の更新手順

1. **辞書管理ツールを開く**
   ```
   https://your-domain.pages.dev/dictionary-manager.html
   ```

2. **辞書を編集**
   - 新しいブランド名を追加
   - 既存の項目を編集/削除

3. **コードを生成してコピー**
   - フロントエンド用コード → `script.js`に貼り付け
   - バックエンド用コード → `workers_final_complete.js`に貼り付け

4. **再デプロイ**
   - Cloudflare Pages: 自動デプロイ（GitHubプッシュ時）
   - Cloudflare Workers: `wrangler deploy`

## 🔗 関連リンク

- **本番URL**: https://sirusiru-noce.pages.dev
- **Workers API**: https://sirusiru-noce-proxy.tsuji-090.workers.dev
- **辞書管理**: https://sirusiru-noce.pages.dev/dictionary-manager.html

## ⚠️ 注意事項

- このフォルダのファイルは本番環境に直接デプロイされます
- 変更前に必ずバックアップを作成してください
- 辞書変更後はWorkersの再デプロイが必要です

## 🆕 最新機能 (2025年9月23日追加)

### 自動チャージ通知システム
- **リアルタイム通知**: トークン自動チャージ時にユーザーへ即座に通知
- **チャット内表示**: 💳アイコン付きの緑色通知バー
- **ヘッダー通知**: 画面上部の一時的な通知メッセージ
- **残高警告**: 残高5以下でオレンジ色の警告表示
- **ツールチップ**: 自動チャージ機能の詳細説明

### 複数ファイルアップロード
- **一括選択**: クォータ制限に合わせた複数ファイル選択
- **進捗表示**: アップロード進捗とファイル合計サイズ表示
- **エラーハンドリング**: 個別ファイルのエラー詳細表示

### テスト機能
```javascript
// ブラウザコンソールで自動チャージ通知をテスト
testAutoChargeNotification();
```

---
最終更新: 2025年9月23日