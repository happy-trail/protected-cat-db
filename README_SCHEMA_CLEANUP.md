# 保護猫DB テーブル設計整理

## 変更点
- 猫の基本情報から `rescue_location`, `rescue_details` を削除し、観察日記の「保護時の記録」に移動。
- 猫の基本情報の `death_date`, `death_cause` と専用 `deaths` テーブルを削除し、観察日記の「死亡記録」に移動。
- `observations` に `entry_type`, `rescue_location`, `rescue_details`, `death_date`, `death_cause`, `veterinary_hospital`, `death_note` を追加。
- 死亡記録を観察日記に保存すると、猫の状態を「死亡」に更新。
- PDFの観察日記欄にも保護時・死亡時の記録を出力。

## 適用順
1. Supabaseで復旧手段を確認する。
2. `schema_cleanup_migration.sql` 全体をSQL Editorで実行する。
3. GitHub PagesのリポジトリにこのZIPのファイルを反映する。
4. 通常の観察、保護時記録、死亡記録、PDF出力、権限別ログインをテストする。

この移行SQLは `cats` の4列と `deaths` テーブルを削除します。ユーザーの希望に沿った破壊的変更なので、実行前にバックアップを確認してください。
