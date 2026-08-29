-- Mevcut tekil `caption` metnini `overlay_elements` içine bir "text" tipi
-- katman olarak taşıyan VERİ migration'ı (şema değişikliği yok —
-- `overlay_elements` migration_story_overlay_elements.sql'den beri zaten
-- jsonb). Bu, çoklu bağımsız metin katmanı özelliğinin (bkz.
-- app/stories.py::parse_overlay_elements "text" dalı) geriye dönük parçası:
-- eski hikayelerin metni artık overlay_elements'te de görünsün diye.
--
-- `caption`/`caption_position_x/y`/`caption_style`/`caption_color` sütunları
-- SİLİNMEZ/BOŞALTILMAZ — story_archive(), storyArchive.js ve özellikle
-- save_highlight() (highlight'lara SADECE düz caption kopyalanır) hâlâ bu
-- sütunları okuyor. Görüntüleyici tarafında çift render, overlay_elements
-- içinde bir "text" elemanı VARSA eski caption yolunun çizilmemesiyle
-- önlenir (bkz. stories.js/StoryViewerScreen.kt "hasTextLayer" kontrolü) —
-- bu guard'ın bu migration'la AYNI dağıtımda gitmesi gerekir.
--
-- Idempotent: sadece overlay_elements'inde HENÜZ "text" tipi eleman
-- OLMAYAN, caption'ı dolu satırlar güncellenir; ikinci çalıştırma no-op'tur.
update public.stories s
set overlay_elements =
        coalesce(s.overlay_elements, '[]'::jsonb)
        || jsonb_build_array(jsonb_build_object(
               'type',       'text',
               'text',       s.caption,
               -- caption'ın KENDİ varsayılanları (0.5/0.75) kullanılıyor,
               -- overlay elemanlarının genel varsayılanı (0.5/0.5) DEĞİL —
               -- aksi halde eski metinler yukarı kayar.
               'position_x', coalesce(s.caption_position_x, 0.5),
               'position_y', coalesce(s.caption_position_y, 0.75),
               'scale',      1.0,
               'rotation',   0,
               'style',      s.caption_style,
               'color',      s.caption_color
           ))
where s.caption is not null
  and btrim(s.caption) <> ''
  and (s.overlay_elements is null or jsonb_typeof(s.overlay_elements) = 'array')
  and not exists (
        select 1
        from jsonb_array_elements(coalesce(s.overlay_elements, '[]'::jsonb)) e
        where e->>'type' = 'text'
  );

NOTIFY pgrst, 'reload schema';

-- ROLLBACK:
-- update public.stories s
-- set overlay_elements = nullif((
--         select coalesce(jsonb_agg(e), '[]'::jsonb)
--         from jsonb_array_elements(s.overlay_elements) e
--         where e->>'type' <> 'text'
--     ), '[]'::jsonb)
-- where s.overlay_elements is not null and jsonb_typeof(s.overlay_elements) = 'array';
-- NOT: bu rollback migration SONRASI kullanıcıların editörde GERÇEKTEN eklediği
-- text katmanlarını da siler (hepsi 'text' tipinde, ayırt edilemez) — sadece
-- acil geri alma için, normal koşulda ÇALIŞTIRILMAZ.
