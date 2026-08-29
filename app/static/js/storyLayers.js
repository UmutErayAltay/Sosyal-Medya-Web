// Hikaye katman editörü + görüntüleyici render'ı — Instagram tarzı çoklu
// bağımsız metin/GIF-sticker/mention/hashtag katmanı, iki-parmak pinch+rotate.
//
// Neden AYRI dosya (stories.js'e eklenmedi): stories.js zaten 1100+ satır;
// bu modül hem composer'da (sürükle/pinch/rotate düzenleme) hem viewer'da
// (salt render) kullanılıyor, ikisi de aynı `applyTransform` builder'ını
// paylaşmalı (composer/viewer arasında konum hesaplaması SAPMASIN diye).
//
// Bugüne kadar İKİ AYRI ama BİREBİR AYNI sürükleme bloğu vardı
// (storyPollDragState/storyCaptionDragState, stories.js:184-336) — global
// `document` pointermove/pointerup dinleyicileri, TEK elemanlık state objesi.
// Çoklu katman (metin dahil, en fazla 10) için bu ölçeklenmiyordu. Burada
// TEK bir düşük seviyeli `bindDraggable()` — her öğe kendi pointerdown/move/
// up/cancel dinleyicisini `setPointerCapture` ile kendi üzerinde tutuyor,
// global state objesi YOK. Anket widget'ı (stories.js) DA bu AYNI fonksiyonu
// kullanır — katman listesine (overlay_elements) DAHİL olmasa bile aynı
// jest motorunu paylaşır, iki kopya kod OLMASIN diye.
//
// Backend sözleşmesi: app/stories.py::parse_overlay_elements() — her eleman
// {type, position_x, position_y, scale, rotation, ...tipe özel alanlar}.
(function () {
    'use strict';

    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function clamp01(v) { return clamp(v, 0, 1); }
    function clampScale(v) { return clamp(v, 0.3, 3); }
    // Matematiksel modulo (JS'in `%`'i negatifte negatif kalan verir) —
    // backend'in `% 360.0` normalize'ıyla AYNI sonucu üretir.
    function norm360(deg) {
        var r = deg % 360;
        return r < 0 ? r + 360 : r;
    }

    function csrfToken() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.content : '';
    }

    // Dönüşüm string'i — composer VE viewer TARAFINDAN paylaşılan TEK builder.
    // SIRA ÖNEMLİ: translate(-50%,-50%) DÖNÜŞMEMİŞ kutuya göre ortalar, bu
    // yüzden EN SOLDA olmalı — rotate önce gelirse ortalama ofsetini de
    // döndürüp katmanı kaydırır. rotation===0 iken bugünkü
    // `translate(-50%,-50%) scale(s)` ile birebir aynı (geriye dönük uyumlu).
    function applyTransform(el, state) {
        el.style.left = (state.position_x * 100) + '%';
        el.style.top = (state.position_y * 100) + '%';
        var rotation = Number(state.rotation) || 0;
        var scale = Number(state.scale) || 1;
        el.style.transform = 'translate(-50%, -50%) rotate(' + rotation + 'deg) scale(' + scale + ')';
    }

    // ------------------------------------------------------------------
    // Düşük seviyeli jest motoru — TEK bir öğeyi sürükle + iki-parmak
    // pinch+rotate ile düzenlenebilir yapar. `state` (position_x/position_y/
    // scale/rotation taşıyan düz obje) YERİNDE mutasyona uğrar.
    //
    // options: {
    //   container:   getBoundingClientRect() referansı (0..1 oran hesabı için)
    //   stage:       (opsiyonel) pointerdown'da öğeyi bunun SONUNA taşır (en üste getirir)
    //   scalable:    (varsayılan true) pinch/wheel ile boyut+döndürme değişsin mi
    //   onChange(state): jest TAMAMLANINCA (parmak(lar) kalkınca) veya wheel'de çağrılır
    //   onTap(state):    (opsiyonel) tek parmakla, ÇOK AZ hareketle biten dokunuş — "düzenle" niyeti
    // }
    function bindDraggable(el, state, options) {
        var pointers = {};
        var gesture = null;
        var moved = 0;
        var scalable = options.scalable !== false;

        function rect() { return options.container.getBoundingClientRect(); }

        function snapshot() {
            var ids = Object.keys(pointers);
            if (ids.length === 1) {
                var p = pointers[ids[0]];
                gesture = {
                    mode: 1, startX: p.x, startY: p.y,
                    startPosX: state.position_x, startPosY: state.position_y,
                };
            } else if (ids.length >= 2) {
                var p1 = pointers[ids[0]];
                var p2 = pointers[ids[1]];
                var dx = p2.x - p1.x;
                var dy = p2.y - p1.y;
                gesture = {
                    mode: 2,
                    startDist: Math.max(1, Math.hypot(dx, dy)),
                    startAngleDeg: Math.atan2(dy, dx) * 180 / Math.PI,
                    startScale: state.scale,
                    startRotation: state.rotation,
                    startCx: (p1.x + p2.x) / 2, startCy: (p1.y + p2.y) / 2,
                    startPosX: state.position_x, startPosY: state.position_y,
                };
            } else {
                gesture = null;
            }
        }

        el.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
            moved = 0;
            el.classList.add('is-active');
            if (options.stage) options.stage.appendChild(el); // en üste getir
            snapshot();
        });

        el.addEventListener('pointermove', function (e) {
            if (!pointers[e.pointerId]) return;
            var prev = pointers[e.pointerId];
            moved += Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
            pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
            if (!gesture) return;
            var r = rect();
            if (gesture.mode === 1) {
                var dxp = (e.clientX - gesture.startX) / r.width;
                var dyp = (e.clientY - gesture.startY) / r.height;
                state.position_x = clamp01(gesture.startPosX + dxp);
                state.position_y = clamp01(gesture.startPosY + dyp);
            } else if (gesture.mode === 2 && scalable) {
                var ids = Object.keys(pointers);
                if (ids.length < 2) return;
                var p1 = pointers[ids[0]];
                var p2 = pointers[ids[1]];
                var dx = p2.x - p1.x;
                var dy = p2.y - p1.y;
                var dist = Math.max(1, Math.hypot(dx, dy));
                var angle = Math.atan2(dy, dx) * 180 / Math.PI;
                state.scale = clampScale(gesture.startScale * (dist / gesture.startDist));
                state.rotation = norm360(gesture.startRotation + (angle - gesture.startAngleDeg));
                var cx = (p1.x + p2.x) / 2;
                var cy = (p1.y + p2.y) / 2;
                state.position_x = clamp01(gesture.startPosX + (cx - gesture.startCx) / r.width);
                state.position_y = clamp01(gesture.startPosY + (cy - gesture.startCy) / r.height);
            }
            applyTransform(el, state);
        });

        function endPointer(e) {
            if (!pointers[e.pointerId]) return;
            delete pointers[e.pointerId];
            try { el.releasePointerCapture(e.pointerId); } catch (err) { /* zaten serbest */ }
            var wasSinglePointerTap = gesture && gesture.mode === 1 && moved < 6 && Object.keys(pointers).length === 0;
            snapshot(); // kalan parmak(lar) için YENİDEN baz al — sıçrama önlenir
            if (Object.keys(pointers).length === 0) {
                el.classList.remove('is-active');
                if (options.onChange) options.onChange(state);
                if (wasSinglePointerTap && options.onTap) options.onTap(state);
            }
        }

        el.addEventListener('pointerup', endPointer);
        el.addEventListener('pointercancel', endPointer);

        if (scalable) {
            // Masaüstü fallback — fare pinch/rotate YAPAMAZ. wheel = boyut,
            // shift+wheel = döndürme.
            el.addEventListener('wheel', function (e) {
                e.preventDefault();
                if (e.shiftKey) {
                    state.rotation = norm360(state.rotation + (e.deltaY > 0 ? 5 : -5));
                } else {
                    state.scale = clampScale(state.scale + (e.deltaY > 0 ? -0.05 : 0.05));
                }
                applyTransform(el, state);
                if (options.onChange) options.onChange(state);
            }, { passive: false });
        }
    }

    // ------------------------------------------------------------------
    // Composer — N katmanlı editör (metin/GIF-sticker/mention/hashtag).
    // Anket widget'ı BUNUN DIŞINDA (stories.js kendi state'ini + AYNI
    // bindDraggable()'ı kullanır) — bkz. dosya başı yorumu.
    // ------------------------------------------------------------------

    // options: { stage, container, maxLayers, onChange(serialized), onLayerTap(layer) }
    function createEditor(options) {
        var layers = [];
        var maxLayers = options.maxLayers || 10;

        function serialize() {
            return layers
                .map(function (l) {
                    var out = {
                        type: l.type,
                        position_x: parseFloat(l.position_x.toFixed(2)),
                        position_y: parseFloat(l.position_y.toFixed(2)),
                        scale: parseFloat(l.scale.toFixed(2)),
                        rotation: parseFloat(l.rotation.toFixed(1)),
                    };
                    if (l.type === 'text') { out.text = l.text; out.style = l.style || null; out.color = l.color || null; }
                    if (l.type === 'image') out.url = l.url;
                    if (l.type === 'mention') out.username = l.username;
                    if (l.type === 'hashtag') out.tag = l.tag;
                    return out;
                })
                // Boş bir metin katmanı (kullanıcı yazmadan kapattıysa) gönderilmez —
                // native'deki AYNI son güvenlik ağı (StoryCreateViewModel.submit()).
                .filter(function (o) { return o.type !== 'text' || (o.text && o.text.trim()); });
        }

        function notifyChange() {
            if (options.onChange) options.onChange(serialize());
        }

        function count() { return layers.length; }
        function canAddMore() { return layers.length < maxLayers; }

        function removeLayer(id) {
            var idx = layers.findIndex(function (l) { return l.id === id; });
            if (idx === -1) return;
            layers[idx].el.remove();
            layers.splice(idx, 1);
            notifyChange();
        }

        function findLayer(id) {
            return layers.find(function (l) { return l.id === id; }) || null;
        }

        function updateTextLayer(id, patch) {
            var layer = findLayer(id);
            if (!layer || layer.type !== 'text') return;
            Object.assign(layer, patch);
            renderTextContent(layer);
            notifyChange();
        }

        function renderTextContent(layer) {
            var textEl = layer.el.querySelector('.story-layer-content');
            textEl.textContent = layer.text || '';
            textEl.classList.remove('pill-light', 'pill-dark');
            if (layer.style === 'pill_light') textEl.classList.add('pill-light');
            if (layer.style === 'pill_dark') textEl.classList.add('pill-dark');
            textEl.style.color = layer.color || '';
        }

        function makeBaseNode(extraClass) {
            var wrap = document.createElement('div');
            wrap.className = 'story-layer ' + extraClass;
            wrap.style.touchAction = 'none';
            var removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'story-layer-remove';
            removeBtn.setAttribute('aria-label', 'Kaldır');
            removeBtn.textContent = '×';
            wrap.appendChild(removeBtn);
            return { wrap: wrap, removeBtn: removeBtn };
        }

        function addLayer(type, data) {
            if (!canAddMore()) return null;
            var id = 'layer-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
            var layer = Object.assign({
                id: id, type: type,
                position_x: 0.5, position_y: type === 'text' ? 0.75 : 0.5,
                scale: 1, rotation: 0,
            }, data);

            var nodes = makeBaseNode('story-layer-' + type);
            var el = nodes.wrap;

            if (type === 'text') {
                var textEl = document.createElement('p');
                textEl.className = 'story-layer-content story-layer-text-content';
                el.insertBefore(textEl, nodes.removeBtn);
                layer.el = el;
                renderTextContent(layer);
            } else if (type === 'image') {
                var img = document.createElement('img');
                img.src = layer.url;
                img.alt = '';
                img.className = 'story-layer-content';
                el.insertBefore(img, nodes.removeBtn);
                layer.el = el;
            } else if (type === 'mention' || type === 'hashtag') {
                var pill = document.createElement('span');
                pill.className = 'story-layer-content story-sticker-pill';
                pill.textContent = type === 'mention' ? ('@' + layer.username) : ('#' + layer.tag);
                el.insertBefore(pill, nodes.removeBtn);
                layer.el = el;
            }

            nodes.removeBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                removeLayer(id);
            });

            applyTransform(el, layer);
            options.stage.appendChild(el);
            bindDraggable(el, layer, {
                container: options.container,
                stage: options.stage,
                onChange: notifyChange,
                onTap: function () { if (options.onLayerTap) options.onLayerTap(layer); },
            });
            layers.push(layer);
            notifyChange();
            return layer;
        }

        // Modal her kapanışında çağrılır (form.reset() ile AYNI an) — TÜM
        // katmanları DOM'dan ve state'ten temizler, editör yeniden AÇILIŞA
        // hazır hale gelir (yeni bir createEditor() çağırmaya GEREK YOK,
        // DOM referansları — stage/container — sabit kalıyor).
        function reset() {
            layers.forEach(function (l) { l.el.remove(); });
            layers = [];
        }

        return {
            addLayer: addLayer,
            removeLayer: removeLayer,
            findLayer: findLayer,
            updateTextLayer: updateTextLayer,
            serialize: serialize,
            count: count,
            canAddMore: canAddMore,
            reset: reset,
        };
    }

    // ------------------------------------------------------------------
    // Viewer — N katmanı salt render (sürüklenemez)
    // ------------------------------------------------------------------

    // Önceki slide'ın katmanlarını temizler — `.story-text-slide` temizleme
    // deseninin (stories.js showStory()) genellemesi. Düğümler HER slide'da
    // sıfırdan oluşturulur, ASLA yeniden kullanılmaz (stil sızıntısı riski
    // yapısal olarak ortadan kalkar).
    function clearViewerLayers(mediaArea) {
        mediaArea.querySelectorAll('.story-overlay-layer').forEach(function (n) { n.remove(); });
    }

    // callbacks: { onNavigateToProfile(username), onNavigateToHashtag(tag) }
    function renderViewerLayers(mediaArea, elements, callbacks) {
        clearViewerLayers(mediaArea);
        if (!elements || !elements.length) return;
        callbacks = callbacks || {};

        elements.forEach(function (el) {
            var node;
            if (el.type === 'text') {
                node = document.createElement('p');
                node.className = 'story-overlay-layer story-layer-text-content';
                node.textContent = el.text || '';
                if (el.style === 'pill_light') node.classList.add('pill-light');
                if (el.style === 'pill_dark') node.classList.add('pill-dark');
                node.style.color = el.color || '';
                node.style.pointerEvents = 'none';
            } else if (el.type === 'image') {
                node = document.createElement('img');
                node.className = 'story-overlay-layer';
                node.src = el.url;
                node.alt = '';
                node.style.pointerEvents = 'none';
            } else if (el.type === 'mention') {
                node = document.createElement('a');
                node.className = 'story-overlay-layer story-sticker-pill';
                node.textContent = '@' + el.username;
                node.href = '/u/' + encodeURIComponent(el.username);
                node.addEventListener('click', function (e) {
                    if (callbacks.onNavigateToProfile) {
                        e.preventDefault();
                        callbacks.onNavigateToProfile(el.username);
                    }
                });
            } else if (el.type === 'hashtag') {
                node = document.createElement('a');
                node.className = 'story-overlay-layer story-sticker-pill';
                node.textContent = '#' + el.tag;
                node.href = '/hashtag/' + encodeURIComponent(el.tag);
                node.addEventListener('click', function (e) {
                    if (callbacks.onNavigateToHashtag) {
                        e.preventDefault();
                        callbacks.onNavigateToHashtag(el.tag);
                    }
                });
            } else {
                return;
            }
            applyTransform(node, {
                position_x: el.position_x != null ? el.position_x : 0.5,
                position_y: el.position_y != null ? el.position_y : 0.5,
                scale: el.scale != null ? el.scale : 1,
                rotation: el.rotation != null ? el.rotation : 0,
            });
            mediaArea.appendChild(node);
        });
    }

    // ------------------------------------------------------------------
    // Küçük yardımcı seçiciler (GIF/sticker/mention arama) — mevcut
    // uçları DOĞRUDAN çağırır, postModal.js/mentionAutocomplete.js'in
    // form'a-özel state'ine BAĞLANMAZ (bu composer'ın kendi hidden
    // input sözleşmesi yok, katmanlar doğrudan JS state'inde tutuluyor).
    // ------------------------------------------------------------------

    function searchGifs(query, callback) {
        fetch('/gif/search' + (query ? ('?q=' + encodeURIComponent(query)) : ''))
            .then(function (r) { return r.json(); })
            .then(function (data) { callback(data.gifs || []); })
            .catch(function () { callback([]); });
    }

    function fetchMyStickers(callback) {
        fetch('/stickers/mine')
            .then(function (r) { return r.json(); })
            .then(function (data) { callback(data.stickers || []); })
            .catch(function () { callback([]); });
    }

    function searchMentionUsers(query, callback) {
        if (!query || query.trim().length < 1) { callback([]); return; }
        fetch('/social/mentions/search?q=' + encodeURIComponent(query.trim()))
            .then(function (r) { return r.ok ? r.json() : { users: [] }; })
            .then(function (data) { callback(data.users || []); })
            .catch(function () { callback([]); });
    }

    window.StoryLayers = {
        applyTransform: applyTransform,
        bindDraggable: bindDraggable,
        createEditor: createEditor,
        clearViewerLayers: clearViewerLayers,
        renderViewerLayers: renderViewerLayers,
        searchGifs: searchGifs,
        fetchMyStickers: fetchMyStickers,
        searchMentionUsers: searchMentionUsers,
        norm360: norm360,
        clampScale: clampScale,
        clamp01: clamp01,
        csrfToken: csrfToken,
    };
})();
