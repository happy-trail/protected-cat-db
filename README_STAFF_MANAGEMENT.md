# 管理者用スタッフ管理機能

この更新ではPWAに管理者専用の「スタッフ管理」画面を追加しています。認証アカウントの作成はブラウザから直接行わず、Supabase Edge Function `cat-user-admin` が処理します。

## 追加される機能
- 管理者のみ「スタッフ管理」ボタンを表示
- 表示名・メールアドレス・初期パスワードを指定してスタッフ／閲覧者を作成
- 登録済みプロフィールとメールアドレスの一覧
- staff / viewer の権限変更
- 利用停止・利用再開（`profiles.active` を切り替え）
- ログイン中の自分自身と既存の管理者アカウントは画面から変更不可

## 1. Edge FunctionをSupabaseへ配置

プロジェクトのルートディレクトリでSupabase CLIを利用し、次を実行します。

```bash
supabase login
supabase link --project-ref byktxquvkxyfynomaqtf
supabase functions deploy cat-user-admin
```

この関数はSupabaseが提供する `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` の環境変数を使用します。通常は自動提供されるため、PWAの `config.js` にService Role Keyを追加しないでください。関数のJWT検証は有効のままにしてください。

## 2. PWAをGitHub Pagesへ反映

ZIP内の `index.html`、`app.js`、`styles.css`、`sw.js` などを既存の `protected-cat-db` リポジトリへ上書きしてコミット／プッシュしてください。既存の `config.js` のSupabase URL、公開用Anon Key、Google Client IDは保持してください。

公開URL： https://kty52100-png.github.io/protected-cat-db/

Service Workerのキャッシュ名は v10 に更新済みです。デプロイ後、PWAを再読み込みしてください。古い表示が残る場合はブラウザで再読み込みするか、PWAを一度閉じて開き直してください。

## 3. テスト
1. 管理者アカウントでログインし、「スタッフ管理」ボタンが見えることを確認。
2. テスト用メールアドレスで「閲覧者」を作成。
3. 一覧に表示されることを確認。
4. ログアウトし、テストユーザーでログインして閲覧のみであることを確認。
5. 管理者に戻り、利用停止→ログイン後に利用不可、利用再開→利用可能になることを確認。
6. スタッフ権限も必要に応じて別のテストアカウントで確認。

## 注意
- 初期パスワードは本人へ安全な方法で伝え、ログイン後に変更してもらってください。パスワード変更画面はこの更新には含めていません。
- 利用停止は `profiles.active=false` にしてアプリ内アクセスを拒否します。既存のログインセッションを即時に全端末から強制失効する機能ではありません。アプリは再読み込み・プロフィール再確認時に停止状態を検出します。
- `profiles` テーブルに `id`, `display_name`, `role`, `active` が存在する前提です。
- 既存の猫情報、写真、観察日記、医療情報、譲渡情報、PDF出力の処理は変更していません。
