-- 保護猫DBの設計整理：保護情報・死亡情報を観察日記へ集約
-- 重要データがない前提の変更SQL。実行前にSupabaseのバックアップを確認してください。
-- このSQLは cats.rescue_location / rescue_details / death_date / death_cause と deaths テーブルを削除します。
-- 観察日記に専用列を追加し、cat_summaryビューを新しい設計に作り直します。
BEGIN;

-- 旧ビュー・旧関数・旧制約の依存を解除
DROP VIEW IF EXISTS public.cat_summary;
DROP FUNCTION IF EXISTS public.record_cat_death(uuid, date, text, text, text);
ALTER TABLE public.cats DROP CONSTRAINT IF EXISTS cats_death_consistency;

-- 観察日記で保護時・死亡時の記録を構造化して保存
ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS rescue_location text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS rescue_details text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS death_date date,
  ADD COLUMN IF NOT EXISTS death_cause text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS veterinary_hospital text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS death_note text NOT NULL DEFAULT '';

ALTER TABLE public.observations DROP CONSTRAINT IF EXISTS observations_entry_type_check;
ALTER TABLE public.observations ADD CONSTRAINT observations_entry_type_check
  CHECK (entry_type IN ('daily', 'rescue', 'death'));

-- catsから重複項目を削除
ALTER TABLE public.cats DROP COLUMN IF EXISTS rescue_location;
ALTER TABLE public.cats DROP COLUMN IF EXISTS rescue_details;
ALTER TABLE public.cats DROP COLUMN IF EXISTS death_date;
ALTER TABLE public.cats DROP COLUMN IF EXISTS death_cause;

-- 専用死亡テーブルを削除（死亡記録はobservationsに保存）
DROP TABLE IF EXISTS public.deaths;

-- 古い列を含まない cat_summary ビューを再作成
CREATE VIEW public.cat_summary WITH (security_invoker = true) AS
SELECT
    c.id,
    c.management_no,
    c.name,
    c.sex,
    c.breed,
    c.rescued_date,
    c.estimated_birth_date,
    c.estimated_age_text,
    c.status,
    c.neuter_status,
    c.current_note,
    c.main_photo_file_id,
    (
        SELECT jsonb_agg(
            jsonb_build_object(
                'id', v.id,
                'date', v.vaccination_date,
                'type', v.vaccine_type,
                'hospital', v.veterinary_hospital,
                'note', v.note
            ) ORDER BY v.vaccination_date DESC
        )
        FROM public.vaccinations v
        WHERE v.cat_id = c.id
    ) AS vaccinations,
    (
        SELECT jsonb_agg(
            jsonb_build_object(
                'id', t.id,
                'date', t.test_date,
                'fiv', t.fiv_result,
                'felv', t.felv_result,
                'hospital', t.veterinary_hospital,
                'note', t.note
            ) ORDER BY t.test_date DESC
        )
        FROM public.virus_tests t
        WHERE t.cat_id = c.id
    ) AS virus_tests,
    (
        SELECT jsonb_agg(
            jsonb_build_object(
                'id', s.id,
                'date', s.surgery_date,
                'type', s.surgery_type,
                'hospital', s.veterinary_hospital,
                'note', s.note
            ) ORDER BY s.surgery_date DESC
        )
        FROM public.surgeries s
        WHERE s.cat_id = c.id
    ) AS surgeries,
    (
        SELECT jsonb_agg(
            jsonb_build_object(
                'id', o.id,
                'date', o.observation_date,
                'observer_id', o.observer_id,
                'condition', o.condition,
                'appetite', o.appetite,
                'stool', o.stool,
                'urine', o.urine,
                'behavior', o.behavior,
                'weight_kg', o.weight_kg,
                'temperature_c', o.temperature_c,
                'memo', o.memo
            ) ORDER BY o.observation_date DESC, o.created_at DESC
        )
        FROM public.observations o
        WHERE o.cat_id = c.id
    ) AS observations,
    (
        SELECT jsonb_agg(
            jsonb_build_object(
                'id', f.id,
                'drive_file_id', f.drive_file_id,
                'file_name', f.file_name,
                'mime_type', f.mime_type,
                'file_url', f.file_url,
                'category', f.category,
                'taken_at', f.taken_at,
                'is_main_photo', f.is_main_photo
            ) ORDER BY f.is_main_photo DESC, f.taken_at DESC NULLS LAST, f.created_at DESC
        )
        FROM public.cat_files f
        WHERE f.cat_id = c.id
    ) AS files
FROM public.cats c
WHERE c.deleted_at IS NULL;


;

COMMIT;

-- 確認用：catsから対象列がなく、observationsに新しい列があることを確認
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'cats' AND column_name IN ('rescue_location','rescue_details','death_date','death_cause'))
    OR (table_name = 'observations' AND column_name IN ('entry_type','rescue_location','rescue_details','death_date','death_cause','veterinary_hospital','death_note')))
ORDER BY table_name, column_name;
