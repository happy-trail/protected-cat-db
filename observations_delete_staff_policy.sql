-- 観察日記の削除をスタッフ・管理者に許可するRLSポリシー
-- Supabase SQL Editorで一度だけ実行してください。
-- 既存の管理者向けDELETEポリシーは削除しません。

drop policy if exists observations_delete_staff_or_admin on public.observations;
create policy observations_delete_staff_or_admin
on public.observations
for delete
to authenticated
using (public.is_staff_or_admin());
