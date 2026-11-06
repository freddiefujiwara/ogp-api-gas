# ogp-api-gas

OGP（Open Graph）取得を専用化した Google Apps Script の Web API です。
ブログ（blog-gas）など複数のサイトから共通で使います。

## API

```
GET {exec}?url=<取得したいURL>
```

レスポンス（JSON）:

```json
{ "url": "...", "title": "...", "image": "...", "description": "..." }
```

- OG情報が取れないURLでは `title` / `image` / `description` が空文字になります
- 結果は CacheService に6時間キャッシュされます（失敗は10分）
- 取得は20件ずつの並列バッチ＋時間予算（40秒）で行い、遅いサイトがあっても呼び出し側を長時間待たせません
- 本文はページが宣言する文字コード（HTTPヘッダ→metaタグの順）で復号します。楽天市場のShift_JISページの文字化け対策です

## キャッシュの事前温め

6時間ごとのタイマーで `warmOgCache` が動き、対象フォルダ内の全ドキュメントから
単独リンクを集めて先に取得しておきます。呼び出し側はほぼキャッシュヒットになります。

### セットアップ

1. スクリプトプロパティ `WARM_FOLDER_IDS` に対象の Drive フォルダIDをカンマ区切りで設定
   （例：ブログの本番フォルダと下書きフォルダ）
2. エディタで `setupWarmTrigger` を1回実行（既存の同名トリガーは付け替えられます）

## 開発

- `npm test` : Vitest（カバレッジ付き）
- `npm run build` : `src/Code.js` → `dist/Code.gs` 変換
- デプロイは GitHub Actions（Node CI）:
  - main 以外のブランチへの push → ステージング用プロジェクト
  - main へのマージ → 本番プロジェクト
- 必要な Secrets: `CLASPRC_JSON` / `DEPLOYMENT_ID`（本番）/ `STAGING_SCRIPT_ID` / `STAGING_DEPLOYMENT_ID`
