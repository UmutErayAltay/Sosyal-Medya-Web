// Hikaye arşivi (24 saatte silinmeyen, süresi dolmuş hikayeler) — profildeki
// "Hikaye Arşivim" butonuyla açılan MVP modal. Backend hazır: GET
// /stories/archive (session-cookie, HER ZAMAN çağıranın kendi arşivi),
// POST /stories/<id>/save-highlight ve POST /stories/<id>/delete süresi
// dolmuş hikayeler üzerinde de çalışıyor (bkz. app/stories.py). Sadece
// profile.html'de var (is_self bloğu), diğer sayfalarda elemanlar yok —
// stories.js/storyHighlights.js'teki "elemanı bul, yoksa no-op" deseni.

(function () {
    function csrfToken() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.content : '';
    }

    var openBtn = document.getElementById('story-archive-open-btn');
    var listModal = document.getElementById('story-archive-modal');
    var listClose = document.getElementById('story-archive-close');
    var grid = document.getElementById('story-archive-grid');

    var detailModal = document.getElementById('story-archive-detail-modal');
    var detailClose = document.getElementById('story-archive-detail-close');
    var detailMedia = document.getElementById('story-archive-detail-media');
    var highlightBtn = document.getElementById('story-archive-highlight-btn');
    var deleteBtn = document.getElementById('story-archive-delete-btn');

    if (!openBtn || !listModal) return; // sadece is_self profilinde var

    var archivedStories = [];
    var activeStory = null;
    var listLastFocused = null;
    var detailLastFocused = null;

    function shortCaption(text) {
        if (!text) return '';
        return text.length > 60 ? text.slice(0, 60) + '…' : text;
    }

    function renderThumb(s) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'story-archive-thumb';
        btn.dataset.storyId = s.id;

        if (s.image_url) {
            var img = document.createElement('img');
            img.src = s.image_url;
            img.alt = '';
            img.loading = 'lazy';
            btn.appendChild(img);
        } else if (s.video_url) {
            var video = document.createElement('video');
            video.src = s.video_url;
            video.muted = true;
            video.setAttribute('aria-hidden', 'true');
            btn.appendChild(video);
        } else {
            btn.style.backgroundColor = s.background_color || 'var(--border)';
            if (s.caption) {
                var capDiv = document.createElement('div');
                capDiv.className = 'story-archive-thumb-caption';
                if (s.caption_color) capDiv.style.color = s.caption_color;
                capDiv.textContent = shortCaption(s.caption);
                btn.appendChild(capDiv);
            }
        }
        btn.addEventListener('click', function () { openDetail(s); });
        return btn;
    }

    function renderGrid() {
        if (!grid) return;
        grid.innerHTML = '';
        if (!archivedStories.length) {
            grid.innerHTML = '<p class="muted center">Arşivlenmiş hikayen yok — süresi dolan hikayeler otomatik olarak burada birikir.</p>';
            return;
        }
        archivedStories.forEach(function (s) { grid.appendChild(renderThumb(s)); });
    }

    async function loadArchive() {
        if (!grid) return;
        grid.innerHTML = '<p class="muted center">Yükleniyor...</p>';
        try {
            var res = await fetch('/stories/archive', { headers: { 'X-Requested-With': 'fetch' } });
            if (!res.ok) throw new Error('İstek başarısız: ' + res.status);
            var data = await res.json();
            archivedStories = data.stories || [];
            renderGrid();
        } catch (err) {
            console.error('Hikaye arşivi yüklenemedi:', err);
            grid.innerHTML = '<p class="muted center">Arşiv yüklenemedi, tekrar dene.</p>';
        }
    }

    function openList() {
        listLastFocused = document.activeElement;
        listModal.hidden = false;
        document.body.style.overflow = 'hidden';
        if (listClose) listClose.focus();
        loadArchive();
    }

    function closeList() {
        listModal.hidden = true;
        document.body.style.overflow = '';
        if (listLastFocused) listLastFocused.focus();
    }

    function openDetail(s) {
        activeStory = s;
        detailLastFocused = document.activeElement;
        if (detailMedia) {
            detailMedia.innerHTML = '';
            if (s.image_url) {
                var img = document.createElement('img');
                img.src = s.image_url;
                img.alt = '';
                detailMedia.appendChild(img);
            } else if (s.video_url) {
                var video = document.createElement('video');
                video.src = s.video_url;
                video.controls = true;
                video.playsInline = true;
                detailMedia.appendChild(video);
            } else {
                detailMedia.style.backgroundColor = s.background_color || 'var(--card)';
            }
            if (s.caption && !s.image_url && !s.video_url) {
                // Salt-metin hikaye: yazı ortada, medya yoksa arkaplan zaten yukarıda ayarlandı
                var capP = document.createElement('p');
                capP.className = 'story-archive-detail-caption';
                capP.style.position = 'static';
                if (s.caption_color) capP.style.color = s.caption_color;
                capP.textContent = s.caption;
                detailMedia.appendChild(capP);
            } else if (s.caption) {
                var capOverlay = document.createElement('div');
                capOverlay.className = 'story-archive-detail-caption';
                if (s.caption_color) capOverlay.style.color = s.caption_color;
                capOverlay.textContent = s.caption;
                detailMedia.appendChild(capOverlay);
            }
        }
        if (!s.image_url && !s.video_url) detailMedia.style.backgroundColor = s.background_color || 'var(--card)';
        else detailMedia.style.backgroundColor = '';

        detailModal.hidden = false;
        document.body.style.overflow = 'hidden';
        if (detailClose) detailClose.focus();
    }

    function closeDetail() {
        detailModal.hidden = true;
        document.body.style.overflow = 'hidden'; // liste modalı hâlâ açık
        activeStory = null;
        if (detailLastFocused) detailLastFocused.focus();
    }

    function removeFromGrid(storyId) {
        archivedStories = archivedStories.filter(function (s) { return s.id !== storyId; });
        renderGrid();
    }

    openBtn.addEventListener('click', openList);
    if (listClose) listClose.addEventListener('click', closeList);
    if (listModal) {
        listModal.addEventListener('click', function (e) { if (e.target === listModal) closeList(); });
    }

    if (detailClose) detailClose.addEventListener('click', closeDetail);
    if (detailModal) {
        detailModal.addEventListener('click', function (e) { if (e.target === detailModal) closeDetail(); });
    }
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (detailModal && !detailModal.hidden) { closeDetail(); return; }
        if (listModal && !listModal.hidden) closeList();
    });

    if (highlightBtn) {
        highlightBtn.addEventListener('click', async function () {
            if (!activeStory) return;
            // MVP: storyHighlights.js'teki picker modalı sadece feed.html'de var
            // (stories-bar'a bağımlı), profilde YOK. Kullanıcı raporu: tarayıcının
            // KENDİ window.prompt()'u "site diyor ki" gibi markasız bir chrome
            // metni gösterip kötü görünüyordu — appAlert/appConfirm ile AYNI
            // görsel dile sahip window.appPrompt() (confirmModal.js) kullanılıyor.
            var title = await window.appPrompt('Öne çıkan başlığı:');
            if (title === null) return; // vazgeçildi
            title = title.trim();
            if (!title) { await window.appAlert('Bir başlık gir.'); return; }
            try {
                var res = await fetch('/stories/' + activeStory.id + '/save-highlight', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
                    body: JSON.stringify({ new_title: title }),
                });
                var data = await res.json().catch(function () { return {}; });
                if (!res.ok || !data.ok) throw new Error(data.error || 'İstek başarısız: ' + res.status);
                await window.appAlert('Öne çıkanlara eklendi.');
                closeDetail();
            } catch (err) {
                await window.appAlert(err.message || 'Öne çıkanlara eklenemedi.');
            }
        });
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', async function () {
            if (!activeStory) return;
            if (!await window.appConfirm('Bu arşivlenmiş hikayeyi silmek istiyor musun?')) return;
            var storyId = activeStory.id;
            try {
                var res = await fetch('/stories/' + storyId + '/delete', {
                    method: 'POST',
                    headers: { 'X-Requested-With': 'fetch', 'X-CSRF-Token': csrfToken() },
                });
                if (!res.ok) throw new Error('İstek başarısız: ' + res.status);
                removeFromGrid(storyId);
                closeDetail();
            } catch (err) {
                console.error('Arşivlenmiş hikaye silinemedi:', err);
                await window.appAlert('Silinemedi, tekrar dene.');
            }
        });
    }
})();
