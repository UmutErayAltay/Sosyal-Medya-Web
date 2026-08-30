// Hikaye: ekleme modalı (görsel/video önizleme, mutual-exclusive — post'un
// aksine hikaye TEK medyalı, bkz. app/stories.py create_story()) + görüntüleyici
// (Instagram tarzı: ilerleme çubukları, sol/sağ tıklama ile önceki/sonraki,
// görseller 5sn sonra otomatik ilerler, videolar bitince ilerler).

(function () {
    var IMAGE_DURATION_MS = 5000;

    function csrfHeader() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.content : '';
    }

    // domUtils.js'ten (common bundle, her sayfada bu dosyadan ÖNCE yüklenir) —
    // önceden burada ayrı bir kopyası vardı (bkz. denetim/teknik borç).
    var escapeHtml = window.escapeHtml;

    // ============================================================
    // --- Hikaye ekleme modalı ---
    // ============================================================
    var storyModal = document.getElementById('story-modal');
    var addStoryBtn = document.getElementById('add-story-btn');
    var closeStoryModalBtn = document.getElementById('close-story-modal');
    var storyImageInput = document.getElementById('story-image-input');
    var storyImagePreview = document.getElementById('story-image-preview');
    var storyVideoInput = document.getElementById('story-video-input');
    var storyVideoPreview = document.getElementById('story-video-preview');
    var storyPollToggleBtn = document.getElementById('story-poll-toggle-btn');
    var storyPollAddOptionBtn = document.getElementById('story-poll-add-option-btn');
    var storyPollCancelBtn = document.getElementById('story-poll-cancel-btn');
    var storyPollContainer = document.getElementById('story-poll-options-container');
    var storyBgToggleBtn = document.getElementById('story-bg-toggle-btn');
    var storyBgPalette = document.getElementById('story-bg-palette');
    var storyBgInput = document.getElementById('story-bg-input');
    var storyTextColorPalette = document.getElementById('story-text-color-palette');
    var storyTextColorInput = document.getElementById('story-text-color-input');
    var storyTextStyleBtn = document.getElementById('story-text-style-btn');
    var storyMediaPreviewInner = document.querySelector('.story-media-preview-inner');
    var storyVisibilityInput = document.getElementById('story-visibility-input');
    var storyVisibilityWrap = document.querySelector('.story-visibility-wrap');
    var storyVisibilityBtn = document.getElementById('story-visibility-btn');
    var storyVisibilityMenu = document.getElementById('story-visibility-menu');
    var storyVisibilityBtnContent = document.getElementById('story-visibility-btn-content');
    var storyOverlayElementsInput = document.getElementById('story-overlay-elements-input');
    var storyCaptionInput = document.getElementById('story-caption-input');

    // ------------------------------------------------------------------
    // Çoklu katman editörü (storyLayers.js) — metin/GIF-sticker/mention/
    // hashtag. Kullanıcı raporu ("storye metin eklediğimizde sadece 1 tane
    // ekliyor, 2.sine tıklayınca öncekini düzenliyor"): "Yazı" butonu HER
    // tıklamada YENİ katman ekler (activeTextLayerId = null -> sonraki
    // tuş vuruşu yeni katman yaratır), canvas'taki mevcut bir yazıya
    // dokunmak (onLayerTap) SADECE o katmanı `#story-caption-input`'a
    // yükleyip düzenler.
    // ------------------------------------------------------------------
    var storyMediaPreviewWrapEl = document.querySelector('.story-media-preview-wrap');
    var storyEditor = (storyMediaPreviewInner && storyMediaPreviewWrapEl)
        ? window.StoryLayers.createEditor({
            stage: storyMediaPreviewInner,
            container: storyMediaPreviewWrapEl,
            maxLayers: 10,
            onChange: function (serialized) {
                if (storyOverlayElementsInput) {
                    storyOverlayElementsInput.value = serialized.length ? JSON.stringify(serialized) : '';
                }
                // Aktif katman (× butonuyla) silinmiş olabilir — kontrol
                // panelini artık VAR OLMAYAN bir katmana bağlı bırakma.
                if (activeLayerKind === 'layer' && activeLayerId && !storyEditor.findLayer(activeLayerId)) {
                    clearActiveLayerControl();
                }
                // AYNI mantık activeTextLayerId (metin textarea'sının bağlı
                // olduğu katman) için de gerekli — code review bulgusu: ×
                // ile silinen bir metin katmanı düzenlenirken textarea'ya
                // yazmaya devam edilirse updateTextLayer() var-olmayan bir
                // id'ye giderdi, findLayer() sessizce miss edip her tuş
                // vuruşu HİÇBİR ŞEY yapmadan kaybolurdu.
                if (activeTextLayerId && !storyEditor.findLayer(activeTextLayerId)) {
                    activeTextLayerId = null;
                    currentTextStyle = null;
                    currentTextColor = null;
                    if (storyCaptionInput) storyCaptionInput.value = '';
                    updateTextControlsVisibility();
                }
            },
            onLayerTap: function (layer) {
                if (layer.type !== 'text') return;
                activeTextLayerId = layer.id;
                currentTextStyle = layer.style || null;
                currentTextColor = layer.color || null;
                if (storyCaptionInput) {
                    storyCaptionInput.value = layer.text || '';
                    storyCaptionInput.focus();
                }
                updateTextControlsVisibility();
            },
            // Kullanıcı raporu: "web'de çevirme yok" — iki parmak pinch+rotate
            // masaüstünde YOK, wheel/shift+wheel fallback'i tamamen GİZLİ bir
            // jestti (görsel ipucu yok). Herhangi bir katmana dokunulunca
            // görünür Boyut/Döndürme slider'ı gösteren panel açılır.
            onLayerActivate: function (layer) { setActiveLayerControl('layer', layer.id, layer); },
        })
        : null;

    // "Aktif metin katmanı" — null: bir sonraki tuş vuruşu YENİ bir katman
    // yaratır. Var olan bir id: `#story-caption-input`'taki değişiklikler O
    // katmanı günceller (canvas'taki mevcut yazıya dokununca set edilir).
    var activeTextLayerId = null;
    var currentTextStyle = null;
    var currentTextColor = null;

    function updateTextControlsVisibility() {
        var hasActiveText = !!(storyCaptionInput && storyCaptionInput.value.trim());
        if (storyTextColorPalette) storyTextColorPalette.hidden = !hasActiveText;
        if (storyTextStyleBtn) storyTextStyleBtn.hidden = !hasActiveText;
        if (storyTextColorPalette) {
            storyTextColorPalette.querySelectorAll('.story-text-color-swatch').forEach(function (sw) {
                sw.classList.toggle('selected', sw.dataset.color === currentTextColor);
            });
        }
    }

    // ------------------------------------------------------------------
    // Aktif katman kontrol paneli — Boyut/Döndürme slider'ı. Kullanıcı
    // raporu: "web'de çevirme yok" — iki parmak pinch+rotate masaüstünde
    // YOK, wheel/shift+wheel fallback'i tamamen GİZLİ bir jestti. Herhangi
    // bir katmana (metin/GIF-sticker/mention/hashtag/anket) dokununca bu
    // panel açılır ve o katmanın scale/rotation'ını GÖRÜNÜR şekilde kontrol
    // eder — wheel fallback'i de aynen çalışmaya devam eder (ikisi AYNI
    // state'i günceller).
    var storyLayerControls = document.getElementById('story-layer-controls');
    var storyLayerScaleSlider = document.getElementById('story-layer-scale-slider');
    var storyLayerRotationSlider = document.getElementById('story-layer-rotation-slider');
    var activeLayerKind = null; // 'layer' | 'poll' | null
    var activeLayerId = null;

    function setActiveLayerControl(kind, id, state) {
        activeLayerKind = kind;
        activeLayerId = id;
        if (storyLayerControls) storyLayerControls.hidden = false;
        if (storyLayerScaleSlider) storyLayerScaleSlider.value = state.scale;
        if (storyLayerRotationSlider) storyLayerRotationSlider.value = state.rotation;
    }

    function clearActiveLayerControl() {
        activeLayerKind = null;
        activeLayerId = null;
        if (storyLayerControls) storyLayerControls.hidden = true;
    }

    function applyActiveLayerPatch(patch) {
        if (activeLayerKind === 'poll') {
            Object.assign(pollState, patch);
            if (storyPollPreviewWidget) window.StoryLayers.applyTransform(storyPollPreviewWidget, pollState);
            syncPollHiddenInputs();
        } else if (activeLayerKind === 'layer' && activeLayerId && storyEditor) {
            var stillExists = storyEditor.findLayer(activeLayerId);
            if (!stillExists) { clearActiveLayerControl(); return; }
            storyEditor.updateLayerTransform(activeLayerId, patch);
        }
    }

    if (storyLayerScaleSlider) {
        storyLayerScaleSlider.addEventListener('input', function (e) {
            applyActiveLayerPatch({ scale: window.StoryLayers.clampScale(parseFloat(e.target.value)) });
        });
    }
    if (storyLayerRotationSlider) {
        storyLayerRotationSlider.addEventListener('input', function (e) {
            applyActiveLayerPatch({ rotation: parseFloat(e.target.value) });
        });
    }
    // Boş canvas alanına (bir katmanın DIŞINA) dokununca paneli kapat.
    if (storyMediaPreviewInner) {
        storyMediaPreviewInner.addEventListener('pointerdown', function (e) {
            if (e.target === storyMediaPreviewInner) clearActiveLayerControl();
        });
    }

    function openStoryModal() {
        if (!storyModal) return;
        storyModal.hidden = false;
        document.body.style.overflow = 'hidden';
        var ta = storyModal.querySelector('textarea');
        if (ta) setTimeout(function () { ta.focus(); }, 50);
    }

    function closeStoryModal() {
        if (!storyModal) return;
        storyModal.hidden = true;
        document.body.style.overflow = '';
        var form = storyModal.querySelector('form');
        if (form) form.reset();
        if (storyImagePreview) storyImagePreview.innerHTML = '';
        if (storyVideoPreview) { storyVideoPreview.style.display = 'none'; storyVideoPreview.removeAttribute('src'); }
        if (storyPollContainer) storyPollContainer.hidden = true;
        // Renk seçicisini gizle ve reset et
        if (storyBgPalette) storyBgPalette.hidden = true;
        if (storyBgInput) storyBgInput.value = '';
        // Çoklu katman editörünü tamamen temizle (metin/GIF/mention/hashtag) —
        // form.reset() DOM'da elle eklenmiş .story-layer düğümlerine dokunmaz,
        // storyEditor.reset() bunları siler.
        if (storyEditor) storyEditor.reset();
        activeTextLayerId = null;
        currentTextStyle = null;
        currentTextColor = null;
        if (storyOverlayElementsInput) storyOverlayElementsInput.value = '';
        if (storyTextColorPalette) storyTextColorPalette.hidden = true;
        if (storyTextStyleBtn) storyTextStyleBtn.hidden = true;
        resetPollState();
        clearActiveLayerControl();
        closeAllStoryPickerPanels();
        if (storyGifSearchInput) storyGifSearchInput.value = '';
        if (storyGifResults) storyGifResults.innerHTML = '';
        if (storyMentionSearchInput) storyMentionSearchInput.value = '';
        if (storyMentionResults) storyMentionResults.innerHTML = '';
        if (storyHashtagInput) storyHashtagInput.value = '';
        if (storyMediaPreviewInner) storyMediaPreviewInner.style.backgroundColor = '';
        // Swatch'ları deselect et
        if (storyBgPalette) {
            storyBgPalette.querySelectorAll('.story-bg-swatch').forEach(function (sw) {
                sw.classList.remove('selected');
            });
        }
        // Yazı rengi seçicisini reset et — storyBgPalette ile AYNI mantık
        if (storyTextColorInput) storyTextColorInput.value = '';
        if (storyTextColorPalette) {
            storyTextColorPalette.querySelectorAll('.story-text-color-swatch').forEach(function (sw) {
                sw.classList.remove('selected');
            });
        }
        // Görünürlük dropdown'ını varsayılana döndür — varsayılan sunucu
        // tarafında hesabın gizlilik durumuna göre hesaplanıp
        // `.story-visibility-wrap[data-default-value]`'a yazılıyor (gizli
        // hesap -> followers, açık hesap -> public), sabit kodlanmıyor.
        var storyDefaultValue = (storyVisibilityWrap && storyVisibilityWrap.dataset.defaultValue) || 'public';
        if (storyVisibilityMenu) {
            var defaultItem = storyVisibilityMenu.querySelector('.story-visibility-item[data-value="' + storyDefaultValue + '"]');
            if (defaultItem && storyVisibilityBtnContent) storyVisibilityBtnContent.innerHTML = defaultItem.innerHTML;
            storyVisibilityMenu.querySelectorAll('.story-visibility-item').forEach(function (i) {
                i.classList.toggle('selected', i.dataset.value === storyDefaultValue);
            });
            storyVisibilityMenu.hidden = true;
        }
        if (storyVisibilityBtn) storyVisibilityBtn.setAttribute('aria-expanded', 'false');
        if (storyVisibilityInput) storyVisibilityInput.value = storyDefaultValue;
    }

    if (addStoryBtn) addStoryBtn.addEventListener('click', openStoryModal);
    if (closeStoryModalBtn) closeStoryModalBtn.addEventListener('click', closeStoryModal);
    if (storyModal) {
        storyModal.addEventListener('click', function (e) {
            if (e.target === storyModal) closeStoryModal();
        });
    }

    // Görsel/video mutual-exclusive: hikaye tek medyalı, biri seçilince diğeri temizlenir.
    if (storyImageInput && storyImagePreview) {
        storyImageInput.addEventListener('change', function (e) {
            storyImagePreview.innerHTML = '';
            var file = e.target.files[0];
            if (!file) return;
            if (storyVideoInput) storyVideoInput.value = '';
            if (storyVideoPreview) { storyVideoPreview.style.display = 'none'; storyVideoPreview.removeAttribute('src'); }
            var reader = new FileReader();
            reader.onload = function (ev) {
                var wrap = document.createElement('div');
                wrap.className = 'image-preview-item';
                wrap.innerHTML = '<img src="' + ev.target.result + '" alt="Önizleme">';
                storyImagePreview.appendChild(wrap);
            };
            reader.readAsDataURL(file);
        });
    }
    if (storyVideoInput && storyVideoPreview) {
        storyVideoInput.addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (!file) { storyVideoPreview.style.display = 'none'; storyVideoPreview.removeAttribute('src'); return; }
            if (storyImageInput) storyImageInput.value = '';
            if (storyImagePreview) storyImagePreview.innerHTML = '';
            storyVideoPreview.src = URL.createObjectURL(file);
            storyVideoPreview.style.display = 'block';
        });
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && storyModal && !storyModal.hidden) closeStoryModal();
    });

    // Hikaye metin katmanı girişi: içeriğe göre otomatik büyür/küçülür —
    // comments.js/chat.js ile AYNI desen (manuel resize tutamacı yerine).
    //
    // Kullanıcı raporu ("storye metin eklediğimizde sadece 1 tane ekliyor,
    // 2.sine tıklayınca öncekini düzenliyor"): `activeTextLayerId` null iken
    // İLK tuş vuruşu YENİ bir katman yaratır (canvas'ta "Yazı" butonu veya
    // bu textarea'nın kendisi bunu tetikler); id doluysa (canvas'taki mevcut
    // bir yazıya dokunulmuşsa, bkz. onLayerTap) SADECE o katman güncellenir.
    // Metin boşaltılırsa katman SİLİNİR (native'deki AYNI davranış).
    document.addEventListener('input', function (e) {
        if (e.target.id !== 'story-caption-input' || !storyEditor) return;
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';

        var value = e.target.value;
        if (activeTextLayerId === null) {
            if (value.trim()) {
                var newLayer = storyEditor.addLayer('text', { text: value, style: currentTextStyle, color: currentTextColor });
                if (newLayer) {
                    activeTextLayerId = newLayer.id;
                    setActiveLayerControl('layer', newLayer.id, newLayer);
                }
            }
        } else if (!value.trim()) {
            storyEditor.removeLayer(activeTextLayerId);
            if (activeLayerId === activeTextLayerId) clearActiveLayerControl();
            activeTextLayerId = null;
        } else {
            storyEditor.updateTextLayer(activeTextLayerId, { text: value });
        }

        updateTextControlsVisibility();
    });

    // "Yazı" butonu — HER tıklama YENİ bir katman başlatır: aktif düzenlemeyi
    // bırakır (varsa boşsa siler) ve textarea'yı boşaltıp odaklar, bir
    // sonraki tuş vuruşu (yukarıdaki input handler) taze bir katman yaratır.
    var storyAddTextBtn = document.getElementById('story-add-text-btn');
    if (storyAddTextBtn) {
        storyAddTextBtn.addEventListener('click', function () {
            if (!storyEditor) return;
            if (activeTextLayerId !== null) {
                var current = storyEditor.findLayer(activeTextLayerId);
                if (current && !current.text.trim()) storyEditor.removeLayer(activeTextLayerId);
            }
            activeTextLayerId = null;
            currentTextStyle = null;
            currentTextColor = null;
            if (storyCaptionInput) {
                storyCaptionInput.value = '';
                storyCaptionInput.style.height = 'auto';
                storyCaptionInput.focus();
            }
            updateTextControlsVisibility();
        });
    }

    // Yazı stili döngüsü — null (klasik) -> pill_light -> pill_dark -> null,
    // SADECE aktif katman için (native onTextStyleCycle ile AYNI mantık).
    if (storyTextStyleBtn) {
        storyTextStyleBtn.addEventListener('click', function () {
            if (activeTextLayerId === null) return;
            currentTextStyle = currentTextStyle === null ? 'pill_light'
                : currentTextStyle === 'pill_light' ? 'pill_dark' : null;
            storyEditor.updateTextLayer(activeTextLayerId, { style: currentTextStyle });
        });
    }

    // Anket oluşturma modalında widget'ı sürüklenebilir + pinch ile
    // ölçeklenebilir + iki-parmakla döndürülebilir yap — storyLayers.js'in
    // paylaşılan `bindDraggable()`'ı (eskiden BURADA storyPollDragState/
    // storyCaptionDragState adında İKİ AYRI ama BİREBİR AYNI global-document
    // sürükleme bloğu vardı, bkz. dosya başı yorumu).
    var storyPollPreviewWidget = document.getElementById('story-poll-preview-widget');
    var storyPollScaleSlider = document.getElementById('story-poll-scale-slider');
    var storyPollScaleDisplay = document.getElementById('story-poll-scale-display');
    var storyPollScaleControl = document.getElementById('story-poll-scale-control');
    var pollState = { position_x: 0.5, position_y: 0.5, scale: 1, rotation: 0 };

    function syncPollHiddenInputs() {
        var posXInput = storyPollContainer ? storyPollContainer.querySelector('input[name="poll_position_x"]') : null;
        var posYInput = storyPollContainer ? storyPollContainer.querySelector('input[name="poll_position_y"]') : null;
        var scaleInput = storyPollContainer ? storyPollContainer.querySelector('input[name="poll_scale"]') : null;
        var rotationInput = document.getElementById('story-poll-rotation-input');
        if (posXInput) posXInput.value = pollState.position_x.toFixed(2);
        if (posYInput) posYInput.value = pollState.position_y.toFixed(2);
        if (scaleInput) scaleInput.value = pollState.scale.toFixed(2);
        if (rotationInput) rotationInput.value = pollState.rotation.toFixed(1);
        if (storyPollScaleSlider) storyPollScaleSlider.value = pollState.scale;
        if (storyPollScaleDisplay) storyPollScaleDisplay.textContent = Math.round(pollState.scale * 100) + '%';
    }

    function resetPollState() {
        pollState.position_x = 0.5;
        pollState.position_y = 0.5;
        pollState.scale = 1;
        pollState.rotation = 0;
        if (storyPollPreviewWidget) window.StoryLayers.applyTransform(storyPollPreviewWidget, pollState);
        syncPollHiddenInputs();
    }

    if (storyPollPreviewWidget && storyMediaPreviewWrapEl) {
        window.StoryLayers.bindDraggable(storyPollPreviewWidget, pollState, {
            container: storyMediaPreviewWrapEl,
            onChange: syncPollHiddenInputs,
            onActivate: function () { setActiveLayerControl('poll', null, pollState); },
        });
    }

    // Anket boyutu slider'ı — masaüstünde pinch yapılamadığı için manuel
    // fallback (native/web ortak "wheel/slider" deseni).
    if (storyPollScaleSlider) {
        storyPollScaleSlider.addEventListener('input', function (e) {
            pollState.scale = window.StoryLayers.clampScale(parseFloat(e.target.value));
            if (storyPollPreviewWidget) window.StoryLayers.applyTransform(storyPollPreviewWidget, pollState);
            syncPollHiddenInputs();
        });
    }

    // Oluşturma önizlemesi, GERÇEK paylaşılacak anket görünümüyle (bkz.
    // _post_card.html poll_widget makrosu, .poll-widget/.poll-option CSS'i)
    // birebir aynı markup'ı kullanır — kullanıcı isteği: "orada tam
    // paylaşılacak hali gözüksün". Önceden düz metin/kutu (sahte önizleme)
    // kullanılıyordu, gerçek anketle hiç benzemiyordu.
    function updateStoryPollPreview(options) {
        if (!storyPollPreviewWidget) return;
        var html = '<div class="poll-widget">';
        (options || []).forEach(function (text) {
            var trimmed = text.trim();
            if (!trimmed) return;
            html += '<div class="poll-option">' +
                '<span class="poll-option-bar" style="width: 0%"></span>' +
                '<span class="poll-option-label">' + escapeHtml(trimmed) + '</span>' +
                '<span class="poll-option-pct">0%</span>' +
                '</div>';
        });
        html += '<p class="muted poll-total">0 oy</p></div>';
        storyPollPreviewWidget.innerHTML = html;
    }

    // Hikaye formu: anket toggle ve seçenek ekleme
    if (storyPollToggleBtn) {
        storyPollToggleBtn.addEventListener('click', function (e) {
            e.preventDefault();
            if (storyPollContainer) {
                var wasHidden = storyPollContainer.hidden;
                storyPollContainer.hidden = !wasHidden;
                var nowOpen = wasHidden; // wasHidden=true -> az önce açıldı (görünür oldu)
                if (nowOpen) {
                    // Görsel/video ile anket ARTIK birlikte var olabilir (kullanıcı
                    // isteği) — önceden burada image/video input'u temizleniyordu,
                    // "görsel eklendikten sonra anket ekleyince görsel kayboluyor"
                    // hatasına yol açıyordu. Poll widget'ı göster + init et
                    if (storyPollPreviewWidget) {
                        storyPollPreviewWidget.hidden = false;
                        resetPollState();
                        updateStoryPollPreview(['Seçenek 1', 'Seçenek 2']);
                    }
                    if (storyPollScaleControl) storyPollScaleControl.hidden = false;
                } else {
                    // Poll'u kapat: widget'ı gizle
                    if (storyPollPreviewWidget) {
                        storyPollPreviewWidget.hidden = true;
                    }
                    if (storyPollScaleControl) storyPollScaleControl.hidden = true;
                }
            }
        });
    }

    // Renk seçici toggle
    if (storyBgToggleBtn) {
        storyBgToggleBtn.addEventListener('click', function (e) {
            e.preventDefault();
            if (storyBgPalette) {
                storyBgPalette.hidden = !storyBgPalette.hidden;
            }
        });
    }

    // Renk swatch'ları — document delegation ile (storyBgPalette'in içinde)
    document.addEventListener('click', function (e) {
        var swatch = e.target.closest('.story-bg-swatch');
        if (!swatch || !storyBgPalette || storyBgPalette.hidden) return;
        e.preventDefault();

        var color = swatch.dataset.color;
        if (!color) return;

        // Tüm swatch'ları deselect et
        storyBgPalette.querySelectorAll('.story-bg-swatch').forEach(function (sw) {
            sw.classList.remove('selected');
        });
        // Bu swatch'ı seçili yap
        swatch.classList.add('selected');

        // Gizli input'a rengi yaz
        if (storyBgInput) storyBgInput.value = color;

        // Medya preview'ı güncelle: rengi uygula, medya varsa yok say.
        if (storyMediaPreviewInner) {
            var hasMedia = storyImagePreview && storyImagePreview.innerHTML.trim() !== '' ||
                          storyVideoPreview && storyVideoPreview.style.display !== 'none';
            if (hasMedia) {
                // Medya varsa renk uygulanmaz (yok sayılır)
                storyMediaPreviewInner.style.backgroundColor = '';
            } else {
                storyMediaPreviewInner.style.backgroundColor = color;
            }
        }
    });

    // Yazı rengi swatch'ları — aynı renge tekrar dokununca (toggle) null'a
    // (varsayılan beyaz) döner, SADECE aktif katman için (native
    // onTextColorChange ile AYNI mantık).
    document.addEventListener('click', function (e) {
        var swatch = e.target.closest('.story-text-color-swatch');
        if (!swatch || !storyTextColorPalette || storyTextColorPalette.hidden) return;
        e.preventDefault();
        if (activeTextLayerId === null || !storyEditor) return;

        var color = swatch.dataset.color;
        if (!color) return;
        currentTextColor = (currentTextColor === color) ? null : color;
        storyEditor.updateTextLayer(activeTextLayerId, { color: currentTextColor });
        if (storyTextColorInput) storyTextColorInput.value = currentTextColor || '';
        updateTextControlsVisibility();
    });


    if (storyPollAddOptionBtn) {
        storyPollAddOptionBtn.addEventListener('click', function (e) {
            e.preventDefault();
            var hidden3 = storyPollContainer.querySelector('input[name="poll_option_3"]');
            var hidden4 = storyPollContainer.querySelector('input[name="poll_option_4"]');
            if (hidden3 && hidden3.hidden) {
                hidden3.hidden = false;
                return;
            }
            if (hidden4 && hidden4.hidden) {
                hidden4.hidden = false;
            }
        });
    }

    // Anket seçenekleri değiştiğinde widget'ı güncelle
    if (storyPollContainer) {
        var pollInputs = storyPollContainer.querySelectorAll('input[type="text"][name^="poll_option_"]');
        pollInputs.forEach(function (inp) {
            inp.addEventListener('input', function () {
                var options = [];
                pollInputs.forEach(function (i) {
                    if (i.value.trim()) options.push(i.value.trim());
                });
                if (options.length >= 2) updateStoryPollPreview(options);
            });
        });
    }

    if (storyPollCancelBtn) {
        storyPollCancelBtn.addEventListener('click', function (e) {
            e.preventDefault();
            if (storyPollContainer) {
                storyPollContainer.hidden = true;
                if (storyPollContainer.querySelector('input[name="poll_option_3"]')) {
                    storyPollContainer.querySelector('input[name="poll_option_3"]').hidden = true;
                }
                if (storyPollContainer.querySelector('input[name="poll_option_4"]')) {
                    storyPollContainer.querySelector('input[name="poll_option_4"]').hidden = true;
                }
                var inputs = storyPollContainer.querySelectorAll('input[type="text"]');
                inputs.forEach(function (inp) { inp.value = ''; });
            }
        });
    }

    // ============================================================
    // --- GIF / Sticker / Bahset / Etiket panelleri ---
    // Native MediaPickerSheet'in web'deki basitleştirilmiş karşılığı —
    // sekmesiz, her biri kendi toggle butonunun altında açılan panel
    // (.story-bg-palette/.story-text-color-palette ile AYNI "toggle
    // butonu -> sessizce açılan panel" deseni). Seçim doğrudan
    // storyEditor.addLayer() çağırır.
    // ============================================================
    var storyGifToggleBtn = document.getElementById('story-gif-toggle-btn');
    var storyGifPanel = document.getElementById('story-gif-panel');
    var storyGifSearchInput = document.getElementById('story-gif-search-input');
    var storyGifResults = document.getElementById('story-gif-results');
    var storyGifLoadingMsg = document.getElementById('story-gif-loading-msg');
    var storyStickerToggleBtn = document.getElementById('story-sticker-toggle-btn');
    var storyStickerPanel = document.getElementById('story-sticker-panel');
    var storyStickerResults = document.getElementById('story-sticker-results');
    var storyMentionToggleBtn = document.getElementById('story-mention-toggle-btn');
    var storyMentionPanel = document.getElementById('story-mention-panel');
    var storyMentionSearchInput = document.getElementById('story-mention-search-input');
    var storyMentionResults = document.getElementById('story-mention-results');
    var storyHashtagToggleBtn = document.getElementById('story-hashtag-toggle-btn');
    var storyHashtagPanel = document.getElementById('story-hashtag-panel');
    var storyHashtagInput = document.getElementById('story-hashtag-input');
    var storyHashtagAddBtn = document.getElementById('story-hashtag-add-btn');

    // Aynı anda tek panel açık olsun — bir tanesini açmak diğerlerini kapatır
    // (attach-menu'lerdeki AYNI "tekil açık panel" deseni).
    var allStoryPickerPanels = [storyGifPanel, storyStickerPanel, storyMentionPanel, storyHashtagPanel];
    function closeAllStoryPickerPanels(except) {
        allStoryPickerPanels.forEach(function (p) { if (p && p !== except) p.hidden = true; });
    }
    function toggleStoryPickerPanel(panel) {
        if (!panel) return;
        var willOpen = panel.hidden;
        closeAllStoryPickerPanels(willOpen ? panel : null);
        panel.hidden = !willOpen;
    }

    function tryAddLayer(type, data) {
        if (!storyEditor || !storyEditor.canAddMore()) return null;
        var layer = storyEditor.addLayer(type, data);
        // Yeni eklenen katman HENÜZ dokunulmadığı için onActivate tetiklenmez —
        // kullanıcı ekler eklemez Boyut/Döndürme panelini görsün diye elle açılır.
        if (layer) setActiveLayerControl('layer', layer.id, layer);
        return layer;
    }

    // --- GIF ---
    if (storyGifToggleBtn && storyGifPanel) {
        storyGifToggleBtn.addEventListener('click', function () {
            toggleStoryPickerPanel(storyGifPanel);
            if (!storyGifPanel.hidden) runGifSearch('');
        });
    }
    var gifSearchDebounce = null;
    function runGifSearch(query) {
        if (storyGifLoadingMsg) storyGifLoadingMsg.hidden = false;
        if (storyGifResults) storyGifResults.innerHTML = '';
        window.StoryLayers.searchGifs(query, function (gifs) {
            if (storyGifLoadingMsg) storyGifLoadingMsg.hidden = true;
            if (!storyGifResults) return;
            storyGifResults.innerHTML = '';
            gifs.forEach(function (gif) {
                var img = document.createElement('img');
                img.src = gif.preview || gif.url;
                img.alt = 'GIF';
                img.addEventListener('click', function () {
                    tryAddLayer('image', { url: gif.url });
                    storyGifPanel.hidden = true;
                });
                storyGifResults.appendChild(img);
            });
        });
    }
    if (storyGifSearchInput) {
        storyGifSearchInput.addEventListener('input', function () {
            clearTimeout(gifSearchDebounce);
            var q = storyGifSearchInput.value;
            gifSearchDebounce = setTimeout(function () { runGifSearch(q); }, 400);
        });
    }

    // --- Sticker ---
    if (storyStickerToggleBtn && storyStickerPanel) {
        storyStickerToggleBtn.addEventListener('click', function () {
            toggleStoryPickerPanel(storyStickerPanel);
            if (!storyStickerPanel.hidden) {
                window.StoryLayers.fetchMyStickers(function (stickers) {
                    if (!storyStickerResults) return;
                    storyStickerResults.innerHTML = '';
                    stickers.forEach(function (sticker) {
                        var img = document.createElement('img');
                        img.src = sticker.image_url;
                        img.alt = 'Sticker';
                        img.addEventListener('click', function () {
                            tryAddLayer('image', { url: sticker.image_url });
                            storyStickerPanel.hidden = true;
                        });
                        storyStickerResults.appendChild(img);
                    });
                });
            }
        });
    }

    // --- Bahset (mention) ---
    if (storyMentionToggleBtn && storyMentionPanel) {
        storyMentionToggleBtn.addEventListener('click', function () {
            toggleStoryPickerPanel(storyMentionPanel);
            if (!storyMentionPanel.hidden && storyMentionSearchInput) storyMentionSearchInput.focus();
        });
    }
    var mentionSearchDebounce = null;
    if (storyMentionSearchInput) {
        storyMentionSearchInput.addEventListener('input', function () {
            clearTimeout(mentionSearchDebounce);
            var q = storyMentionSearchInput.value;
            mentionSearchDebounce = setTimeout(function () {
                window.StoryLayers.searchMentionUsers(q, function (users) {
                    if (!storyMentionResults) return;
                    storyMentionResults.innerHTML = '';
                    users.forEach(function (user) {
                        if (!user.username) return;
                        var btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'story-picker-list-item';
                        if (user.avatar_url) {
                            var img = document.createElement('img');
                            img.src = user.avatar_url;
                            img.alt = '';
                            btn.appendChild(img);
                        }
                        var span = document.createElement('span');
                        span.textContent = '@' + user.username;
                        btn.appendChild(span);
                        btn.addEventListener('click', function () {
                            tryAddLayer('mention', { username: user.username });
                            storyMentionPanel.hidden = true;
                            storyMentionSearchInput.value = '';
                            storyMentionResults.innerHTML = '';
                        });
                        storyMentionResults.appendChild(btn);
                    });
                });
            }, 400);
        });
    }

    // --- Etiket (hashtag) ---
    if (storyHashtagToggleBtn && storyHashtagPanel) {
        storyHashtagToggleBtn.addEventListener('click', function () {
            toggleStoryPickerPanel(storyHashtagPanel);
            if (!storyHashtagPanel.hidden && storyHashtagInput) storyHashtagInput.focus();
        });
    }
    function submitStoryHashtag() {
        if (!storyHashtagInput) return;
        var tag = storyHashtagInput.value.trim().replace(/^#/, '').toLowerCase();
        if (!tag) return;
        tryAddLayer('hashtag', { tag: tag });
        storyHashtagInput.value = '';
        storyHashtagPanel.hidden = true;
    }
    if (storyHashtagAddBtn) storyHashtagAddBtn.addEventListener('click', submitStoryHashtag);
    if (storyHashtagInput) {
        storyHashtagInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submitStoryHashtag(); }
        });
    }

    // Görünürlük dropdown'ı — eski checkbox yerine post-visibility-* ile AYNI
    // özel dropdown deseni (attach-menu/post-more-wrap deseninin devamı).
    // Seçim anında hidden input'u zaten güncellediği için submit'te ayrıca
    // bir dönüşüm gerekmiyor (eski checkbox yaklaşımının aksine).
    function closeStoryVisibilityMenu() {
        if (!storyVisibilityMenu || storyVisibilityMenu.hidden) return;
        storyVisibilityMenu.hidden = true;
        if (storyVisibilityBtn) storyVisibilityBtn.setAttribute('aria-expanded', 'false');
    }

    if (storyVisibilityBtn && storyVisibilityMenu) {
        storyVisibilityBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var willOpen = storyVisibilityMenu.hidden;
            storyVisibilityMenu.hidden = !willOpen;
            storyVisibilityBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });
    }

    document.addEventListener('click', function (e) {
        var item = e.target.closest('.story-visibility-item');
        if (item && storyVisibilityMenu && !storyVisibilityMenu.hidden) {
            e.preventDefault();
            if (storyVisibilityInput) storyVisibilityInput.value = item.dataset.value;
            if (storyVisibilityBtnContent) storyVisibilityBtnContent.innerHTML = item.innerHTML;
            storyVisibilityMenu.querySelectorAll('.story-visibility-item').forEach(function (i) {
                i.classList.remove('selected');
            });
            item.classList.add('selected');
            closeStoryVisibilityMenu();
            return;
        }
        if (storyVisibilityMenu && !storyVisibilityMenu.hidden &&
            !storyVisibilityMenu.contains(e.target) && e.target !== storyVisibilityBtn) {
            closeStoryVisibilityMenu();
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && storyVisibilityMenu && !storyVisibilityMenu.hidden) closeStoryVisibilityMenu();
    });

    // ============================================================
    // --- Hikaye görüntüleyici ---
    // ============================================================
    var viewerModal = document.getElementById('story-viewer-modal');
    var progressRow = document.getElementById('story-progress-row');
    var viewerAvatar = document.getElementById('story-viewer-avatar');
    var viewerUsername = document.getElementById('story-viewer-username');
    var viewerTime = document.getElementById('story-viewer-time');
    var highlightBtn = document.getElementById('story-highlight-btn');
    var deleteBtn = document.getElementById('story-delete-btn');
    var viewerCloseBtn = document.getElementById('story-viewer-close');
    var viewerImage = document.getElementById('story-viewer-image');
    var viewerVideo = document.getElementById('story-viewer-video');
    var viewerCaption = document.getElementById('story-viewer-caption');
    var navPrev = document.getElementById('story-nav-prev');
    var navNext = document.getElementById('story-nav-next');
    var replyForm = document.getElementById('story-reply-form');
    var replyInput = document.getElementById('story-reply-input');
    var replySendBtn = replyForm ? replyForm.querySelector('.story-reply-send-btn') : null;
    var replyAutoPaused = false;
    var reactionsBar = document.getElementById('story-reactions-bar');
    var pollWidget = document.getElementById('story-poll-widget');
    var pollContainer = document.getElementById('story-poll-container');

    var currentStories = [];
    var currentIndex = 0;
    var progressTimer = null;
    var lastFocused = null;
    var isPaused = false;
    var storyStartTime = null;   // aktif oynatma diliminin başlangıcı
    var elapsedPlayed = 0;       // bu hikayede toplam OYNATILMIŞ süre (duraklamalar hariç)

    function timeAgo(iso) {
        var diffMs = Date.now() - new Date(iso).getTime();
        var mins = Math.floor(diffMs / 60000);
        if (mins < 1) return 'şimdi';
        if (mins < 60) return mins + 'dk';
        var hours = Math.floor(mins / 60);
        if (hours < 24) return hours + 'sa';
        return Math.floor(hours / 24) + 'g';
    }

    function buildProgressBars() {
        progressRow.innerHTML = '';
        currentStories.forEach(function () {
            var seg = document.createElement('div');
            seg.className = 'story-progress-seg';
            seg.innerHTML = '<div class="story-progress-fill"></div>';
            progressRow.appendChild(seg);
        });
    }

    function clearTimer() {
        if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    }

    // Aktif hikayenin progress fill'i (document.querySelector hep İLK segmenti bulur)
    function currentFill() {
        var segs = progressRow.querySelectorAll('.story-progress-seg');
        return segs[currentIndex] ? segs[currentIndex].querySelector('.story-progress-fill') : null;
    }

    function setPaused(paused) {
        isPaused = paused;
        var indicator = document.getElementById('story-paused-indicator');
        var fill = currentFill();
        var isVideo = !!(currentStories[currentIndex] && currentStories[currentIndex].video_url);
        if (paused) {
            clearTimer();
            if (!isVideo) {
                if (storyStartTime) elapsedPlayed += Date.now() - storyStartTime;
                // Bar CSS transition ile akıyor; class'la DONDURULAMAZ
                // (animation-play-state sadece animation'a işler) — mevcut
                // genişliği hesaplayıp transition'ı kapatarak sabitle
                if (fill) {
                    var pct = Math.min(100, (elapsedPlayed / IMAGE_DURATION_MS) * 100);
                    fill.style.transition = 'none';
                    fill.style.width = pct + '%';
                }
            }
            if (viewerVideo && !viewerVideo.hidden) viewerVideo.pause();
            if (indicator) indicator.hidden = false;
        } else {
            if (indicator) indicator.hidden = true;
            if (isVideo) {
                // Video kendi kaldığı yerden oynar, onended ile ilerler
                if (viewerVideo && !viewerVideo.hidden) viewerVideo.play().catch(function () { });
                return;
            }
            storyStartTime = Date.now();
            var remaining = Math.max(0, IMAGE_DURATION_MS - elapsedPlayed);
            if (fill) {
                requestAnimationFrame(function () {
                    fill.style.transition = 'width ' + remaining + 'ms linear';
                    fill.style.width = '100%';
                });
            }
            progressTimer = setTimeout(function () { showStory(currentIndex + 1); }, remaining);
        }
    }

    function renderStoryPoll(poll) {
        if (!pollContainer) return;
        pollContainer.innerHTML = '';
        var widget = document.createElement('div');
        widget.className = 'poll-widget';

        // DOM API ile inşa edilir (innerHTML string birleştirme DEĞİL) — opt.text
        // kullanıcı girdisi (anket seçeneği), innerHTML'e ham gömmek XSS riski taşır.
        poll.options.forEach(function (opt) {
            var optBtn = document.createElement('button');
            optBtn.className = 'poll-option' + (poll.my_vote === opt.id ? ' voted' : '');
            optBtn.dataset.optionId = opt.id;
            optBtn.dataset.pollId = poll.id;
            optBtn.setAttribute('aria-label', opt.text + ', yüzde ' + opt.pct + ', ' + opt.votes + ' oy');

            var textSpan = document.createElement('span');
            textSpan.className = 'poll-option-text';
            textSpan.textContent = opt.text;

            var bar = document.createElement('div');
            bar.className = 'poll-option-bar';
            bar.style.width = opt.pct + '%';

            var pctSpan = document.createElement('span');
            pctSpan.className = 'poll-option-pct';
            pctSpan.textContent = opt.pct + '%';

            optBtn.appendChild(textSpan);
            optBtn.appendChild(bar);
            optBtn.appendChild(pctSpan);
            widget.appendChild(optBtn);
        });

        var totalDiv = document.createElement('div');
        totalDiv.className = 'poll-total';
        totalDiv.textContent = poll.total_votes + ' oy';
        widget.appendChild(totalDiv);

        pollContainer.appendChild(widget);

        // Anket widget'ını konumlandır — StoryLayers'ın paylaşılan builder'ı
        // (composer önizlemesiyle AYNI kod yolu, rotation dahil).
        if (pollWidget) {
            window.StoryLayers.applyTransform(pollWidget, {
                position_x: (poll.position_x !== undefined && poll.position_x !== null) ? poll.position_x : 0.5,
                position_y: (poll.position_y !== undefined && poll.position_y !== null) ? poll.position_y : 0.5,
                scale: (poll.scale !== undefined && poll.scale !== null) ? poll.scale : 1,
                rotation: (poll.rotation !== undefined && poll.rotation !== null) ? poll.rotation : 0,
            });
        }
    }

    function showStory(index) {
        clearTimer();
        isPaused = false;
        elapsedPlayed = 0;
        var oldIndicator = document.getElementById('story-paused-indicator');
        if (oldIndicator) oldIndicator.hidden = true;
        if (index < 0) return; // ilk hikayede geri gidilemez
        if (index >= currentStories.length) { closeViewer(); return; }
        currentIndex = index;
        var s = currentStories[index];
        storyStartTime = Date.now();

        // Buton görünürlüğü: ilk hikayede prev gizli, son hikayede next gizli
        var storyPrevBtn = document.getElementById('story-prev-btn');
        var storyNextBtn = document.getElementById('story-next-btn');
        if (storyPrevBtn) storyPrevBtn.hidden = (index === 0);
        if (storyNextBtn) storyNextBtn.hidden = (index === currentStories.length - 1);

        var segs = progressRow.querySelectorAll('.story-progress-seg');
        segs.forEach(function (seg, i) {
            var fill = seg.querySelector('.story-progress-fill');
            fill.style.transition = 'none';
            fill.style.width = i < index ? '100%' : '0%';
        });

        // Çoklu metin katmanı özelliğiyle metin artık overlay_elements
        // içinde bir "text" elemanı olarak da gelebilir — VARSA eski tekil
        // `caption` yolu ÇİZİLMEZ, aksi halde metin ÇİFT görünürdü (bkz.
        // app/stories.py::parse_overlay_elements "çift render kuralı" yorumu,
        // native StoryViewerScreen.kt'deki AYNI guard).
        var hasTextLayer = (s.overlay_elements || []).some(function (e) { return e.type === 'text'; });

        viewerTime.textContent = timeAgo(s.created_at);
        viewerCaption.hidden = hasTextLayer || !s.caption;
        viewerCaption.textContent = s.caption || '';

        // Altyazı konumu: composer'da sürüklenen konum (0-1 arası oran) —
        // anket widget'ının renderStoryPoll()'daki konumlandırma tekniğiyle
        // AYNI. undefined ise varsayılan 0.5/0.75 (backend eski hikayelerde
        // bu alanları henüz döndürmeyebilir).
        var captionPosX = (s.caption_position_x !== undefined && s.caption_position_x !== null) ? s.caption_position_x : 0.5;
        var captionPosY = (s.caption_position_y !== undefined && s.caption_position_y !== null) ? s.caption_position_y : 0.75;
        viewerCaption.style.left = (captionPosX * 100) + '%';
        viewerCaption.style.top = (captionPosY * 100) + '%';
        viewerCaption.style.transform = 'translate(-50%, -50%)';
        // Yazı rengi: composer'da seçilen caption_color — viewerCaption AYNI
        // eleman her showStory() çağrısında yeniden kullanıldığı için, önceki
        // hikayenin rengi SIZMASIN diye caption_color yoksa boşa (CSS
        // varsayılanı beyaza) döner, koşulsuz her seferinde yazılır.
        viewerCaption.style.color = s.caption_color || '';
        // caption_style pil render'ı — web viewer'ında eskiden HİÇ YOKTU,
        // text katmanlarıyla AYNI .pill-light/.pill-dark class'ları (gerçek
        // WYSIWYG). Koşulsuz her seferinde uygulanır/kaldırılır (sızma yok).
        viewerCaption.classList.toggle('pill-light', s.caption_style === 'pill_light');
        viewerCaption.classList.toggle('pill-dark', s.caption_style === 'pill_dark');

        viewerVideo.pause();
        viewerVideo.hidden = true;
        viewerVideo.removeAttribute('src');
        viewerImage.hidden = true;
        viewerImage.removeAttribute('src');
        // Önceki hikayenin salt-metin slide'ı varsa KALDIR — kaldırılmazsa
        // renkli slide sonraki görsel/video hikayenin üzerinde/arkasında
        // ekranda kalıyordu (medya reset'inin parçası)
        var staleTextSlide = document.querySelector('#story-media-area .story-text-slide');
        if (staleTextSlide) staleTextSlide.remove();

        // Çoklu katman render'ı (metin/GIF-sticker/mention/hashtag) — ÖNCE
        // kendi temizliğini yapar (bkz. StoryLayers.clearViewerLayers),
        // düğümler HER slide'da SIFIRDAN oluşturulur (stil sızıntısı riski
        // yapısal olarak ortadan kalkar). Callback verilmez — mention/hashtag
        // `<a href>`'leri varsayılan tarayıcı navigasyonuyla çalışır (bu bir
        // SPA değil, tam sayfa geçişi HER YERDE normal davranış).
        var storyMediaAreaEl = document.getElementById('story-media-area');
        if (storyMediaAreaEl) window.StoryLayers.renderViewerLayers(storyMediaAreaEl, s.overlay_elements);

        // Anket render'ı (varsa)
        if (pollWidget && pollContainer) {
            if (s.poll) {
                renderStoryPoll(s.poll);
                pollWidget.hidden = false;
            } else {
                pollContainer.innerHTML = '';
                pollWidget.hidden = true;
            }
        }

        // Salt-metin hikaye render: medya yoksa ve background_color varsa
        if (!s.video_url && !s.image_url && s.background_color) {
            // Metin zaten slide'ın içinde büyük gösteriliyor — alttaki
            // altyazı bandı gizlenir, yoksa caption ÇİFT görünürdü
            viewerCaption.hidden = true;
            var mediaArea = document.getElementById('story-media-area');
            if (mediaArea) {
                var textSlide = document.createElement('div');
                textSlide.className = 'story-text-slide';
                textSlide.style.backgroundColor = s.background_color;
                // hasTextLayer İSE metin zaten YUKARIDAKİ renderViewerLayers()
                // tarafından `.story-overlay-layer` olarak (bu renkli slide'ın
                // ÜSTÜNDE, mediaArea'ya kardeş olarak) çiziliyor — burada
                // AYRICA bir <p> eklemek ÇİFT görünüme yol açardı, bu yüzden
                // SADECE eski (göç etmemiş) satırlar için <p> oluşturulur.
                if (!hasTextLayer) {
                    var p = document.createElement('p');
                    p.textContent = s.caption || '';
                    // <p> aynı caption_position_x/y'e göre konumlanır (dış div
                    // tam ekranı kaplayan arkaplan konteyner olarak kalır)
                    p.style.left = (captionPosX * 100) + '%';
                    p.style.top = (captionPosY * 100) + '%';
                    p.style.transform = 'translate(-50%, -50%)';
                    // Yazı rengi: her seferinde YENİDEN oluşturulan bir <p>, sızma
                    // riski yok — caption_color varsa uygula, yoksa CSS varsayılanı
                    // (beyaz) geçerli kalsın diye hiç dokunma.
                    if (s.caption_color) p.style.color = s.caption_color;
                    textSlide.appendChild(p);
                }
                mediaArea.insertBefore(textSlide, mediaArea.firstChild);
            }

            // İlerleme çubuğu
            var fill = segs[index].querySelector('.story-progress-fill');
            requestAnimationFrame(function () {
                fill.style.transition = 'width ' + IMAGE_DURATION_MS + 'ms linear';
                fill.style.width = '100%';
            });
            progressTimer = setTimeout(function () { showStory(currentIndex + 1); }, IMAGE_DURATION_MS);
        } else if (s.video_url) {
            viewerVideo.src = s.video_url;
            viewerVideo.hidden = false;
            viewerVideo.currentTime = 0;
            viewerVideo.play().catch(function () { /* autoplay engellenmiş olabilir, tıklayınca oynar */ });
            viewerVideo.onended = function () { showStory(currentIndex + 1); };
        } else {
            viewerImage.src = s.image_url || '';
            viewerImage.hidden = false;
            var fill = segs[index].querySelector('.story-progress-fill');
            requestAnimationFrame(function () {
                fill.style.transition = 'width ' + IMAGE_DURATION_MS + 'ms linear';
                fill.style.width = '100%';
            });
            progressTimer = setTimeout(function () { showStory(currentIndex + 1); }, IMAGE_DURATION_MS);
        }
    }

    async function openViewer(userId) {
        try {
            var res = await fetch('/stories/user/' + userId, { headers: { 'X-Requested-With': 'fetch' } });
            if (!res.ok) throw new Error('İstek başarısız: ' + res.status);
            var data = await res.json();
            if (!data.stories.length) return;

            lastFocused = document.activeElement;
            currentStories = data.stories;
            viewerUsername.textContent = data.is_mine ? 'Sen' : data.username;

            // CF rozeti: birden fazla hikaye CF durumundaysa göster
            var hasCFStory = data.stories.some(function (st) { return st.visibility === 'close_friends'; });
            var cfBadgeEl = viewerUsername.querySelector('.story-cf-badge');
            if (hasCFStory) {
                if (!cfBadgeEl) {
                    cfBadgeEl = document.createElement('span');
                    cfBadgeEl.className = 'story-cf-badge';
                    cfBadgeEl.innerHTML = window.ICONS.heartFilled({ size: 14 });
                    cfBadgeEl.setAttribute('title', 'Yakın arkadaşlar hikayesi');
                    viewerUsername.appendChild(cfBadgeEl);
                }
            } else if (cfBadgeEl) {
                cfBadgeEl.remove();
            }

            if (data.avatar_url) { viewerAvatar.src = data.avatar_url; viewerAvatar.hidden = false; }
            else { viewerAvatar.hidden = true; }
            deleteBtn.hidden = !data.is_mine;
            highlightBtn.hidden = !data.is_mine;
            // Kendi hikayene yanıt/tepki verilemez (Instagram deseni)
            if (replyForm) {
                replyForm.hidden = data.is_mine;
                if (replyInput) replyInput.value = '';
            }
            if (reactionsBar) {
                reactionsBar.hidden = data.is_mine;
            }

            buildProgressBars();
            viewerModal.hidden = false;
            document.body.style.overflow = 'hidden';
            viewerCloseBtn.focus();
            showStory(0);

            // Halka rengi: bu kullanıcının hikayesi artık görüldü sayılır (sunucu
            // zaten /stories/user/<id> çağrısında story_views'e işledi) — client'ta
            // da anında güncelle, sonraki feed yenilemesini beklemeden.
            var btn = document.querySelector('.story-avatar-btn[data-user-id="' + userId + '"]');
            if (btn) { btn.classList.remove('story-unseen'); btn.classList.add('story-seen'); }
        } catch (err) {
            console.error('Hikaye yüklenemedi:', err);
        }
    }

    function closeViewer() {
        clearTimer();
        isPaused = false;
        elapsedPlayed = 0;
        storyStartTime = null;
        viewerVideo.pause();
        viewerModal.hidden = true;
        document.body.style.overflow = '';
        currentStories = [];
        var indicator = document.getElementById('story-paused-indicator');
        if (indicator) indicator.hidden = true;
        if (pollContainer) pollContainer.innerHTML = '';
        if (pollWidget) pollWidget.hidden = true;
        if (lastFocused) lastFocused.focus();
    }

    document.querySelectorAll('.story-avatar-btn[data-user-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { openViewer(btn.dataset.userId); });
    });

    if (viewerCloseBtn) viewerCloseBtn.addEventListener('click', closeViewer);
    if (navPrev) navPrev.addEventListener('click', function () { showStory(currentIndex - 1); });
    if (navNext) navNext.addEventListener('click', function () { showStory(currentIndex + 1); });

    // Buton event'leri (görünür yön butonları)
    var storyPrevBtn = document.getElementById('story-prev-btn');
    var storyNextBtn = document.getElementById('story-next-btn');
    if (storyPrevBtn) storyPrevBtn.addEventListener('click', function () { showStory(currentIndex - 1); });
    if (storyNextBtn) storyNextBtn.addEventListener('click', function () { showStory(currentIndex + 1); });

    // Medya alanı tıklama — duraklat/devam
    if (viewerModal) {
        viewerModal.addEventListener('click', function (e) {
            if (e.target === viewerModal) { closeViewer(); return; }
            // Medya alanı veya onun alt öğelerine tıklandı mı kontrol et
            var mediaArea = document.getElementById('story-media-area');
            if (mediaArea && (e.target === mediaArea || mediaArea.contains(e.target))) {
                // Buton tıklandıysa atla
                if (e.target.classList && (e.target.classList.contains('story-nav-btn') ||
                    e.target.classList.contains('story-nav-zone'))) return;
                // Mention/hashtag linkine tıklamak (StoryLayers.renderViewerLayers)
                // AYRICA duraklatmayı TETİKLEMESİN — link zaten kendi navigasyonunu
                // yapıyor, sayfa hemen ayrılacak.
                if (e.target.closest('a.story-overlay-layer')) return;
                // Duraklat/devam
                setPaused(!isPaused);
            }
        });
    }

    // storyHighlights.js bu event'i dinler — stories.js picker'ın kendisini
    // BİLMEMELİ (gevşek bağlama), sadece hangi hikayenin öne çıkarılacağını fırlatır.
    if (highlightBtn) {
        highlightBtn.addEventListener('click', function () {
            if (!currentStories.length) return;
            document.dispatchEvent(new CustomEvent('open-highlight-picker', {
                detail: { storyId: currentStories[currentIndex].id }
            }));
        });
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', async function () {
            if (!currentStories.length) return;
            if (!await window.appConfirm('Bu hikayeyi silmek istiyor musun?')) return;
            var storyId = currentStories[currentIndex].id;
            try {
                var res = await fetch('/stories/' + storyId + '/delete', {
                    method: 'POST',
                    headers: { 'X-Requested-With': 'fetch', 'X-CSRF-Token': csrfHeader() },
                });
                if (!res.ok) throw new Error('İstek başarısız: ' + res.status);
                currentStories.splice(currentIndex, 1);
                var btn = document.querySelector('.story-avatar-btn[data-user-id]');
                if (!currentStories.length) {
                    closeViewer();
                    // Kendi hikayen kalmadıysa çubuktan tamamen kaldırılması için
                    // en basit ve güvenilir yol: sayfayı yenile.
                    window.location.reload();
                    return;
                }
                buildProgressBars();
                showStory(Math.min(currentIndex, currentStories.length - 1));
            } catch (err) {
                console.error('Hikaye silinemedi:', err);
            }
        });
    }

    // Emoji tepkisi butonları — tıklanınca /react POST et + yanıt input'unda geri bildirim
    if (reactionsBar) {
        // KRİTİK: mousedown'da preventDefault() — aksi halde tarayıcı odağı
        // butona kaydırır, bu da #story-reply-input'un blur handler'ını
        // SENKRON tetikler (reactionsBar'dan .visible kalkar, pointer-events:
        // none ANINDA uygulanır — transition'ı beklemez). Sonuç: mousedown
        // buton üzerinde başlasa da mouseup, artık tıklama-geçirmez hale gelen
        // şeridin ALTINDAKİ elemana (hikaye önceki/sonraki nav-zone'u) düşüyor,
        // click hiç ateşlenmiyor, tepki gönderilmiyordu. preventDefault ile
        // buton hiç fokus almıyor, input fokusu/şerit görünürlüğü korunuyor.
        reactionsBar.addEventListener('mousedown', function (e) {
            if (e.target.closest('.story-reaction-btn')) e.preventDefault();
        });
        reactionsBar.addEventListener('click', async function (e) {
            var btn = e.target.closest('.story-reaction-btn');
            if (!btn) return;
            e.preventDefault();
            if (btn.dataset.busy === '1') return;
            btn.dataset.busy = '1';

            var emoji = btn.dataset.emoji;
            var storyId = currentStories[currentIndex] ? currentStories[currentIndex].id : null;
            if (!storyId) {
                btn.dataset.busy = '0';
                return;
            }

            try {
                var formData = new FormData();
                formData.append('emoji', emoji);
                formData.append('csrf_token', csrfHeader());

                var res = await fetch('/stories/' + storyId + '/react', {
                    method: 'POST', body: formData,
                    headers: { 'X-Requested-With': 'fetch', 'X-CSRF-Token': csrfHeader() },
                });
                if (!res.ok) throw new Error('İstek başarısız');

                // Görsel onay: buton patlama + input placeholder feedback + şeridi kapat
                btn.style.transform = 'scale(1.3)';
                setTimeout(function () { btn.style.transform = 'scale(1)'; }, 200);

                // Yanıt input'unda "Gönderildi ✓" onayı
                if (replyInput) {
                    var originalPlaceholder = replyInput.placeholder;
                    replyInput.placeholder = 'Gönderildi ✓';
                    replyInput.blur(); // Emoji şeridini kapat
                    setTimeout(function () { replyInput.placeholder = originalPlaceholder; }, 2000);
                }
            } catch (err) {
                console.error('Tepki gönderilemedi:', err);
            } finally {
                btn.dataset.busy = '0';
            }
        });
    }

    // Anket oy verme — document-level delegation (AJAX'ta yenilenen anket için)
    document.addEventListener('click', async function (e) {
        var btn = e.target.closest('.poll-option[data-poll-id][data-option-id]');
        // Sadece hikaye görüntüleyicide çalışsın — `reactionsBar.hidden` DEĞİL
        // `viewerModal.hidden` ile kontrol edilir: reactionsBar kendi
        // hikayende BİLEREK gizli (kendi hikayene tepki/yanıt verilemez),
        // ama anket oylaması buna bağlı OLMAMALI — önceki kod reactionsBar'ı
        // guard olarak kullandığı için KENDİ hikayenin anketine hiç oy
        // verilemiyordu (gerçek bug, kullanıcı raporu).
        if (!btn || !viewerModal || viewerModal.hidden) return;
        e.preventDefault();
        if (btn.dataset.busy === '1') return;
        btn.dataset.busy = '1';

        var pollId = btn.dataset.pollId;
        var optionId = btn.dataset.optionId;
        var voteUrl = '/poll/' + pollId + '/vote';

        try {
            var formData = new FormData();
            formData.append('option_id', optionId);
            formData.append('csrf_token', csrfHeader());

            var res = await fetch(voteUrl, {
                method: 'POST', body: formData,
                headers: { 'X-Requested-With': 'fetch', 'X-CSRF-Token': csrfHeader() },
            });
            if (!res.ok) throw new Error('İstek başarısız');
            var data = await res.json();

            var widget = pollContainer.querySelector('.poll-widget');
            if (widget) {
                var totalEl = widget.querySelector('.poll-total');
                if (totalEl) totalEl.textContent = data.total_votes + ' oy';

                data.options.forEach(function (opt) {
                    var optBtn = widget.querySelector('[data-option-id="' + opt.id + '"]');
                    if (!optBtn) return;
                    optBtn.classList.toggle('voted', data.my_vote === opt.id);
                    var bar = optBtn.querySelector('.poll-option-bar');
                    if (bar) bar.style.width = opt.pct + '%';
                    var pct = optBtn.querySelector('.poll-option-pct');
                    if (pct) pct.textContent = opt.pct + '%';
                    optBtn.setAttribute('aria-label', opt.text + ', yüzde ' + opt.pct + ', ' + opt.votes + ' oy');
                });
            }
        } catch (err) {
            console.error('Oy kullanılamadı:', err);
        } finally {
            btn.dataset.busy = '0';
        }
    });

    document.addEventListener('keydown', function (e) {
        if (!viewerModal || viewerModal.hidden) return;
        if (e.key === 'Escape') { closeViewer(); return; }
        // Yanıt kutusuna yazarken ok tuşları imleç hareketi için kullanılır —
        // hikaye gezinmesini TETİKLEMESİN (kullanıcı metin içinde gezinemezdi)
        if (document.activeElement === replyInput) return;
        if (e.key === 'ArrowRight') showStory(currentIndex + 1);
        else if (e.key === 'ArrowLeft') showStory(currentIndex - 1);
    });

    // Yanıt kutusuna odaklanınca: hikaye duraklat + emoji şeridini göster
    if (replyInput) {
        replyInput.addEventListener('focus', function () {
            if (!isPaused) { replyAutoPaused = true; setPaused(true); }
            if (reactionsBar) reactionsBar.classList.add('visible');
        });
        replyInput.addEventListener('blur', function () {
            if (replyAutoPaused) { replyAutoPaused = false; setPaused(false); }
            if (reactionsBar) reactionsBar.classList.remove('visible');
        });
    }

    if (replyForm) {
        replyForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var text = (replyInput.value || '').trim();
            if (!text || !currentStories.length) return;
            var storyId = currentStories[currentIndex].id;
            replySendBtn.disabled = true;
            try {
                var res = await fetch('/stories/' + storyId + '/reply', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfHeader(),
                        'X-Requested-With': 'fetch',
                    },
                    body: JSON.stringify({ text: text }),
                });
                var data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Yanıt gönderilemedi.');
                replyInput.value = '';
                var originalPlaceholder = replyInput.placeholder;
                replyInput.placeholder = 'Gönderildi ✓';
                setTimeout(function () { replyInput.placeholder = originalPlaceholder; }, 2000);
            } catch (err) {
                window.appAlert(err.message || 'Yanıt gönderilemedi.');
            } finally {
                replySendBtn.disabled = false;
            }
        });
    }

    if (viewerModal) {
        viewerModal.addEventListener('click', function (e) {
            if (e.target === viewerModal) closeViewer();
        });
    }
})();
