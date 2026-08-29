-- Hikaye anketinin döndürme (rotation) desteği — Instagram tarzı iki parmak
-- pinch+rotate jesti için. `stories.overlay_elements` zaten jsonb olduğundan
-- metin/görsel/mention/hashtag katmanlarının rotation'ı için şema değişikliği
-- GEREKMİYOR (parser/render tarafında yeni bir jsonb anahtarı olarak eklenir,
-- bkz. app/stories.py::parse_overlay_elements). SADECE `polls` tablosu
-- (migration_story_poll_position.sql'deki position_x/position_y/scale ile
-- AYNI desen) yeni bir sütun alıyor.
alter table public.polls add column if not exists rotation real not null default 0;

NOTIFY pgrst, 'reload schema';

-- ROLLBACK:
-- alter table public.polls drop column if exists rotation;
