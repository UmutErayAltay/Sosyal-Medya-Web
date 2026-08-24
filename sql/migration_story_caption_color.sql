-- Hikaye altyazı (caption) rengi — native Android'de kullanıcı artık
-- caption_style ("pill_light"/"pill_dark" sabit iki stil) yanında yazının
-- kendi RENGİNİ de seçebilecek (9 renk seçeneği).
--
-- Bağlam: caption_style zaten var (bkz.
-- sql/migration_story_caption_style_and_mention_notifications.sql), bu
-- migration ona ek bir serbest metin kolonu ekler — renk paleti backend'de
-- CHECK constraint ile kısıtlanmıyor (native tarafta sabit 9 hex değerden
-- biri gönderiliyor, ileride palet değişebilir diye DB seviyesinde
-- kilitlenmedi; caption_style'daki gibi bir enum CHECK bilinçli olarak
-- eklenmedi).
--
-- stories.caption_color — nullable, DEFAULT yok. Mevcut satırlar NULL
-- kalır (geriye dönük uyumlu) — backend caption_style/background_color
-- gibi opsiyonel alanları zaten NULL kabul ediyor.
alter table public.stories
    add column if not exists caption_color text;

-- ROLLBACK:
-- alter table public.stories drop column if exists caption_color;
