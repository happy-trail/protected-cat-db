-- 写真削除をスタッフ・管理者に許可する
-- 猫本体の削除権限は変更しません。
DROP POLICY IF EXISTS cat_files_delete_admin ON public.cat_files;
DROP POLICY IF EXISTS cat_files_delete_staff_admin ON public.cat_files;

CREATE POLICY cat_files_delete_staff_admin
ON public.cat_files
FOR DELETE
TO authenticated
USING (public.is_staff_or_admin());
