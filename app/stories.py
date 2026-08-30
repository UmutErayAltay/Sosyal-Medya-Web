"""Hikaye (Story): 24 saatte kaybolan ephemeral paylaşım.

Kapsam BİLİNÇLİ OLARAK dar tutuldu (bkz. .context/active_context.md):
tek görsel/video + opsiyonel altyazı, sadece görüntüleme + kendi hikayeni
silme. Yorum/beğeni/"kim gördü" listesi YOK — bunlar normal postlarda zaten
var, hikayeyi ayrı bir "hafif ve hızlı" özellik olarak tutmak için kapsam
dışı bırakıldı.
"""
from datetime import datetime, timezone
import json
import re
from flask import Blueprint, current_app, request, redirect, url_for, session, flash, jsonify
from .decorators import login_required
from .supabase_client import get_sb, retry_on_connection_error
from .storage_helper import upload_image, upload_video
from .blocks import is_blocked_either_way
from .messaging._common import _get_or_create_conversation, _notify_conversation
from .mentions import notify_story_mention
from .polls import create_poll
from .visibility import followed_and_self_ids

bp = Blueprint("stories", __name__)

# Bir hikayeye eklenebilecek TOPLAM overlay eleman sayısı (tip fark etmeksizin:
# text + image + mention + hashtag toplamı) — 2026-08 öncesi 3'tü, çoklu metin
# katmanı özelliğiyle (metin de artık bir overlay elemanı) 10'a çıkarıldı.
MAX_OVERLAY_ELEMENTS = 10

_HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?")


def attach_story_poll(sb, story: dict, me: str) -> None:
    """Tekil bir hikayeye anket verisini ekler (varsa).

    story["poll"] = {"id": ..., "options": [...], "total_votes": ..., "my_vote": ...,
                     "position_x": ..., "position_y": ..., "scale": ...} benzeri.
    """
    story["poll"] = None
    if not story.get("id"):
        return

    try:
        try:
            poll = sb.table("polls").select(
                "id, position_x, position_y, scale, rotation"
            ).eq("story_id", story["id"]).execute().data
        except Exception:
            # sql/migration_story_overlay_rotation.sql henüz uygulanmamışsa
            # `rotation` kolonu yoktur — bu SELECT'i istisnasız yutan dıştaki
            # try/except'e düşerse anket TAMAMEN kaybolurdu (story["poll"]
            # None kalır). create_poll()'daki AYNI "eski kolonlarla fallback"
            # deseni burada da: rotation'sız tekrar dene, varsayılan 0 kullan.
            poll = sb.table("polls").select(
                "id, position_x, position_y, scale"
            ).eq("story_id", story["id"]).execute().data
        if not poll:
            return
        poll_id = poll[0]["id"]
        position_x = poll[0].get("position_x", 0.5)
        position_y = poll[0].get("position_y", 0.75)
        scale = poll[0].get("scale", 1.0)
        rotation = poll[0].get("rotation", 0.0)

        options = sb.table("poll_options").select("id, option_text, position").eq(
            "poll_id", poll_id
        ).order("position").execute().data

        votes = sb.table("poll_votes").select("poll_id, option_id, user_id").eq(
            "poll_id", poll_id
        ).execute().data

        counts: dict = {}
        my_vote = None
        for v in votes:
            counts[v["option_id"]] = counts.get(v["option_id"], 0) + 1
            if v["user_id"] == me:
                my_vote = v["option_id"]

        total = sum(counts.values())
        opt_list = [{
            "id": o["id"], "text": o["option_text"],
            "votes": counts.get(o["id"], 0),
            "pct": round((counts.get(o["id"], 0) / total) * 100) if total else 0,
        } for o in options]

        story["poll"] = {
            "id": poll_id, "options": opt_list, "total_votes": total, "my_vote": my_vote,
            "position_x": position_x, "position_y": position_y, "scale": scale,
            "rotation": rotation,
        }
    except Exception:
        pass


def _escape_like(value: str) -> str:
    """app/api_v1/feed.py::_escape_like ile AYNI gerekçe — PostgREST'in
    ilike()'ı ham değeri Postgres ILIKE desenine aktarıyor, kullanıcının
    girdiği `%`/`_` joker karakter olarak yorumlanıyordu (ör. mention
    sticker'ında username="%" TÜM profilleri eşleştirip rastgele birine
    sahte story_mention bildirimi gönderiyordu — kullanıcı raporu/güvenlik
    incelemesi ile bulundu)."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def parse_overlay_elements(sb, raw: str | None, me: str) -> tuple[list[dict], set[str]]:
    """Hikaye canvas'ına eklenen katmanları (metin/GIF-sticker/mention/hashtag)
    doğrular. `raw`, JSON-encoded string olarak gelen `overlay_elements` form
    alanı (multipart form'da dizi taşımanın standart yolu). Web (`create_story`)
    ve native (`api_create_story`) route'ları AYNI bu fonksiyonu çağırır —
    eskiden mantık SADECE api_v1/stories.py'de vardı, web hiç okumuyordu.

    Döner: (elements, story_mention_recipient_ids). `story_mention_recipient_ids`
    çağıran route tarafından insert SONRASI `notify_story_mention()` ile
    bildirime çevrilmeli (poll ile AYNI "önce insert, sonra yan etki" sırası).

    Dekoratif/kritik-olmayan bir özellik olduğu için bozuk JSON veya geçersiz
    bir eleman TÜM isteği ERROR ETMEZ (400 yok) — poll_scale parse fallback'iyle
    AYNI fail-open felsefesi: sessizce atlanır/normalize edilir. Her eleman
    `type`'a göre ayrı doğrulanır, TÜR FARK ETMEKSİZİN toplam en fazla
    MAX_OVERLAY_ELEMENTS elemanla sınırlanır. Boş liste DEĞİL None saklanır
    ("yokluk = render etme" kontratı) — çağıran bunu `elements or None` ile yapar.
    """
    elements: list[dict] = []
    story_mention_recipient_ids: set = set()
    if not raw:
        return elements, story_mention_recipient_ids

    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        parsed = []
    if not isinstance(parsed, list):
        return elements, story_mention_recipient_ids

    for item in parsed:
        if not isinstance(item, dict):
            continue

        elem_type = item.get("type")
        if elem_type not in ("text", "image", "mention", "hashtag"):
            # type alanı yoksa ama url varsa eski (type'sız) format —
            # geriye dönük uyumluluk için image say.
            elem_type = "image" if isinstance(item.get("url"), str) else None
        if elem_type is None:
            continue

        try:
            position_x = float(item.get("position_x", 0.5))
            if not (0 <= position_x <= 1):
                position_x = 0.5
        except (TypeError, ValueError):
            position_x = 0.5

        try:
            position_y = float(item.get("position_y", 0.5))
            if not (0 <= position_y <= 1):
                position_y = 0.5
        except (TypeError, ValueError):
            position_y = 0.5

        try:
            scale = float(item.get("scale", 1.0))
            if not (0.3 <= scale <= 3):
                scale = 1.0
        except (TypeError, ValueError):
            scale = 1.0

        # rotation: diğer sayısal alanlarla AYNI fail-open desen, ama
        # reddetmek yerine 360'a göre NORMALİZE edilir (bir dokunuş fazla
        # döndürmek geçersiz bir değer değil, sadece bir tur fazla).
        try:
            rotation = float(item.get("rotation", 0.0)) % 360.0
        except (TypeError, ValueError):
            rotation = 0.0

        if elem_type == "text":
            text = item.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            text = text.strip()[:500]

            # style: caption_style ile AYNI doğrulama (yalnızca bu iki değer).
            style = item.get("style")
            if style not in ("pill_light", "pill_dark"):
                style = None

            # color: caption_color/background_color ile AYNI serbest hex regex.
            color = item.get("color")
            if not (isinstance(color, str) and _HEX_COLOR_RE.fullmatch(color)):
                color = None

            elements.append({
                "type": "text", "text": text, "style": style, "color": color,
                "position_x": position_x, "position_y": position_y,
                "scale": scale, "rotation": rotation,
            })
        elif elem_type == "image":
            url = item.get("url")
            if not isinstance(url, str) or not url.strip():
                continue
            elements.append({
                "type": "image", "url": url.strip(),
                "position_x": position_x, "position_y": position_y,
                "scale": scale, "rotation": rotation,
            })
        elif elem_type == "mention":
            uname = item.get("username")
            if not isinstance(uname, str) or not uname.strip():
                continue
            # notify_mentions()'daki AYNI case-insensitive doğrulama — var
            # olmayan kullanıcıya işaret eden sticker SESSİZCE atlanır.
            try:
                prof = sb.table("profiles").select("id, username").ilike(
                    "username", _escape_like(uname.strip())
                ).execute().data
            except Exception as e:
                # "kullanıcı bulunamadı" (prof=[]) ile gerçek bir DB/ağ
                # hatası burada AYNI şekilde ele alınıyor (dekoratif bir
                # sticker yüzünden hikaye paylaşımı bloklanmasın diye,
                # fonksiyonun geri kalanıyla AYNI fail-open felsefesi) —
                # ama loglanmadan geçmesi, bir DB kesintisinin "kullanıcılar
                # hep yazım hatası yapıyor" gibi görünmesine yol açardı
                # (code review bulgusu).
                current_app.logger.error(f"Mention sticker profil araması başarısız (username={uname!r}): {e}")
                prof = []
            if not prof:
                continue
            real_username = prof[0]["username"]
            mentioned_id = prof[0]["id"]
            elements.append({
                "type": "mention", "username": real_username,
                "position_x": position_x, "position_y": position_y,
                "scale": scale, "rotation": rotation,
            })
            if mentioned_id != me:
                story_mention_recipient_ids.add(mentioned_id)
        elif elem_type == "hashtag":
            tag = item.get("tag")
            if not isinstance(tag, str):
                continue
            # extract_hashtags() ile AYNI normalizasyon (küçük harf); baştaki
            # '#' client'tan gelmiş olabilir, saklanmaz.
            tag = tag.strip().lstrip("#").lower()
            if not tag:
                continue
            elements.append({
                "type": "hashtag", "tag": tag,
                "position_x": position_x, "position_y": position_y,
                "scale": scale, "rotation": rotation,
            })

        if len(elements) >= MAX_OVERLAY_ELEMENTS:
            break

    return elements, story_mention_recipient_ids


def _visible_story_filter(sb, me: str, rows: list[dict]) -> list[dict]:
    """Close_friends VE followers hikayelerini eler. Tek toplu sorgu (N+1 yasak):
    - close_friends: sahibi ben DEĞİLSEM ve sahibinin yakın arkadaş listesinde
      DEĞİLSEM görünmez (owner_id IN (...) AND friend_id = me sorgusuyla).
    - followers: sahibi ben DEĞİLSEM ve ben sahibini takip ETMİYORSAM görünmez
      (viewer merkezli — followed_and_self_ids(sb, me) zaten "ben kimi takip
      ediyorum + kendim" kümesini tek sorguda döner, ayrı ters sorguya gerek yok)."""
    if not rows:
        return rows

    # visibility alanı yoksa (eski hikayeler) veya public ise her zaman geçer
    visible_rows = [
        r for r in rows
        if r.get("visibility") not in ("close_friends", "followers") or r.get("user_id") == me
    ]
    close_friends_rows = [r for r in rows if r.get("visibility") == "close_friends" and r.get("user_id") != me]
    followers_rows = [r for r in rows if r.get("visibility") == "followers" and r.get("user_id") != me]

    if close_friends_rows:
        # close_friends hikayesine sahip kişilerin listesi
        owners = list(set(r["user_id"] for r in close_friends_rows))

        # Hangi owners'lar beni yakın arkadaş yapmış — tek sorgu
        my_close_friend_owners = set()
        try:
            results = sb.table("close_friends").select("owner_id").in_("owner_id", owners).eq(
                "friend_id", me
            ).execute().data
            my_close_friend_owners = {r["owner_id"] for r in results}
        except Exception:
            # Tablo yoksa close_friends hikayeleri GİZLİ kalır (fail-closed — gizlilik)
            my_close_friend_owners = set()

        # Close_friends hikayeleri: sahibi beni yakın arkadaş yapmışsa ekle
        for r in close_friends_rows:
            if r["user_id"] in my_close_friend_owners:
                visible_rows.append(r)

    if followers_rows:
        # Ben kimi takip ediyorum (+ kendim) — followers hikayesi görünürlüğü
        # viewer merkezli soruya bakar: "BEN bu sahibi takip ediyor muyum"
        my_followed = followed_and_self_ids(sb, me)
        for r in followers_rows:
            if r["user_id"] in my_followed:
                visible_rows.append(r)

    return visible_rows


def active_stories_bar(sb, me: str, blocked_ids: set) -> list[dict]:
    """Feed'in üstündeki hikaye çubuğu için aktif hikayeleri kullanıcıya göre
    gruplar. Her grup: en yeni hikaye zamanı + "hepsi görüldü mü" bayrağı
    (halka rengini belirlemek için — görülmemiş varsa renkli, hepsi
    görülmüşse gri halka, Instagram deseni).

    NOT: burada eskiden bir `_cleanup_expired_stories(sb)` çağrısı vardı,
    süresi dolmuş hikayeleri fırsatçı olarak (10 dakikada bir throttle'lı)
    fiziksel olarak SİLİYORDU. Kullanıcı isteğiyle (hikaye sahibi kendi
    süresi dolmuş hikayelerini arşivde görüp öne çıkarabilsin/silebilsin)
    o DELETE kaldırıldı — throttle mantığıyla birlikte artık hiçbir şey
    yapmayan bir fonksiyonu (ve global state'ini) burada TUTMAK yerine
    TAMAMEN silindi (code review bulgusu). "Aktif" ile "arşivde" ayrımı
    artık salt `expires_at` filtresiyle yapılır (aktif: `.gt("expires_at",
    now)` — aşağıda; arşiv: `.lte("expires_at", now)` — bkz.
    app/api_v1/stories.py::api_story_archive, SADECE sahibi görür). Kalıcı
    silme artık yalnızca api_delete_story()'den (kullanıcının kendi
    isteğiyle) mümkün."""
    try:
        now = datetime.now(timezone.utc).isoformat()
        rows = sb.table("stories").select(
            "id, user_id, created_at, visibility, profiles!stories_user_id_fkey(username, avatar_url)"
        ).gt("expires_at", now).order("created_at", desc=True).execute().data
    except Exception:
        return []  # migration henüz uygulanmamışsa çubuk boş görünür, feed kırılmaz

    rows = [r for r in rows if r["user_id"] not in blocked_ids]
    rows = _visible_story_filter(sb, me, rows)
    if not rows:
        return []

    story_ids = [r["id"] for r in rows]
    my_viewed = set()
    try:
        my_viewed = {v["story_id"] for v in sb.table("story_views").select("story_id")
                     .eq("user_id", me).in_("story_id", story_ids).execute().data}
    except Exception:
        pass

    grouped: dict = {}
    order: list = []
    for r in rows:
        uid = r["user_id"]
        if uid not in grouped:
            prof = r.get("profiles") or {}
            grouped[uid] = {
                "user_id": uid,
                "username": prof.get("username", "Bilinmeyen"),
                "avatar_url": prof.get("avatar_url"),
                "all_seen": True,
            }
            order.append(uid)
        if r["id"] not in my_viewed:
            grouped[uid]["all_seen"] = False

    result = [grouped[uid] for uid in order]
    # Kendi hikayen varsa listenin en başına al (Instagram deseni)
    result.sort(key=lambda g: 0 if g["user_id"] == me else 1)
    return result


@bp.route("/stories/new", methods=["POST"])
@login_required
@retry_on_connection_error
def create_story():
    """Web hikaye oluşturma — `POST /api/v1/stories` (api_create_story) ile
    AYNI `parse_overlay_elements()` yardımcısını paylaşır (bkz. o fonksiyonun
    docstring'i). `overlay_elements` (çoklu metin/GIF-sticker/mention/hashtag
    katmanı, JSON-encoded form alanı) bu route'ta İLK KEZ okunuyor — eskiden
    SADECE api_v1'de vardı, web hiç desteklemiyordu. `caption_style` (üst
    seviye kolon) web'den YAZILMAZ — web'de yazı stili her zaman
    overlay_elements'teki ilgili metin katmanının kendi `style` alanında
    taşınır.

    Yanıt: `X-Requested-With: fetch` header'ı varsa JSON (yeni katman editörü
    composer'ı için — `delete_story()`'deki AYNI desen), aksi halde eski
    redirect+flash (JS'siz form-POST fallback'i BOZULMADAN kalır)."""
    sb = get_sb()
    me = session["user"]["id"]
    wants_json = request.headers.get("X-Requested-With") == "fetch"

    def _fail(message: str, status: int = 400):
        if wants_json:
            return jsonify(error=message), status
        flash(message, "error")
        return redirect(url_for("routes.feed"))

    caption = request.form.get("caption", "").strip()
    image_file = request.files.get("image")
    video_file = request.files.get("video")
    has_image = bool(image_file and image_file.filename)
    has_video = bool(video_file and video_file.filename)

    # Anket seçenekleri (post'taki same pattern: poll_option_1 .. poll_option_4)
    poll_options_raw = [request.form.get(f"poll_option_{i}", "").strip() for i in range(1, 5)]
    poll_options = [o for o in poll_options_raw if o]
    has_poll = len(poll_options) >= 2

    # Hikaye anketinin sürükle-bırak pozisyon, boyut ve döndürme değerleri
    poll_position_x = 0.5
    poll_position_y = 0.75
    poll_scale = 1.0
    poll_rotation = 0.0
    if has_poll:
        try:
            x_raw = request.form.get("poll_position_x", "0.5")
            poll_position_x = float(x_raw)
            if not (0 <= poll_position_x <= 1):
                poll_position_x = 0.5
        except ValueError:
            poll_position_x = 0.5

        try:
            y_raw = request.form.get("poll_position_y", "0.75")
            poll_position_y = float(y_raw)
            if not (0 <= poll_position_y <= 1):
                poll_position_y = 0.75
        except ValueError:
            poll_position_y = 0.75

        try:
            scale_raw = request.form.get("poll_scale", "1.0")
            poll_scale = float(scale_raw)
            if not (0.3 <= poll_scale <= 3):
                poll_scale = 1.0
        except ValueError:
            poll_scale = 1.0

        try:
            poll_rotation = float(request.form.get("poll_rotation", "0.0")) % 360.0
        except ValueError:
            poll_rotation = 0.0

    # Hikaye altyazısının sürükle-bırak pozisyonu (anket ile AYNI desen) —
    # has_poll'a bağlı DEĞİL, altyazı her hikayede sürüklenebilir olmalı.
    # NOT: bu üç alan (caption_position/style) artık SADECE göç etmemiş eski
    # satırlar ve `overlay_elements` içinde hiç "text" elemanı olmayan geçiş
    # dönemi istekleri için anlamlı — yeni composer metni overlay_elements
    # üzerinden gönderir (bkz. aşağıdaki türetilmiş caption mantığı).
    caption_position_x = 0.5
    try:
        cpx_raw = request.form.get("caption_position_x", "0.5")
        caption_position_x = float(cpx_raw)
        if not (0 <= caption_position_x <= 1):
            caption_position_x = 0.5
    except ValueError:
        caption_position_x = 0.5

    caption_position_y = 0.75
    try:
        cpy_raw = request.form.get("caption_position_y", "0.75")
        caption_position_y = float(cpy_raw)
        if not (0 <= caption_position_y <= 1):
            caption_position_y = 0.75
    except ValueError:
        caption_position_y = 0.75

    # Overlay katmanları (metin/GIF-sticker/mention/hashtag) — paylaşılan
    # parser, api_create_story()'nin BİREBİR aynısı.
    overlay_elements, story_mention_recipient_ids = parse_overlay_elements(
        sb, request.form.get("overlay_elements"), me,
    )

    if not caption and not has_image and not has_video and not has_poll and not overlay_elements:
        return _fail("Boş hikaye paylaşılamaz.")

    # Hikaye tek medyalı (post'un aksine) — basitlik için: görsel + video
    # aynı anda desteklenmiyor, ilk bulunan kullanılır.
    image_url = None
    video_url = None
    if has_image:
        image_url = upload_image(image_file, folder="stories")
        if not image_url:
            return _fail("Görsel yüklenemedi (geçersiz format veya 5MB'tan büyük).")
    elif has_video:
        video_url = upload_video(video_file, folder="stories")
        if not video_url:
            return _fail("Video yüklenemedi (geçersiz format veya 25MB'tan büyük).")

    # background_color ve visibility alanlarını oku
    background_color = request.form.get("background_color", "").strip()
    # Salt-metin hikaye için: background_color hex validasyonu (#XYZ veya #XYZABC)
    if background_color and not re.fullmatch(r"#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?", background_color):
        background_color = None
    # Medya varsa background_color'ı yok say (renk sadece salt-metin için)
    if has_image or has_video:
        background_color = None

    # Altyazı yazı rengi — background_color ile AYNI serbest hex regex.
    # background_color'ın AKSİNE has_image/has_video durumunda null'a
    # DÜŞÜRÜLMEZ — yazının rengi arka planın türünden BAĞIMSIZ bir kavram
    # (bkz. app/api_v1/stories.py::api_create_story, AYNI karar).
    caption_color = (request.form.get("caption_color") or "").strip()
    if caption_color and not re.fullmatch(r"#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?", caption_color):
        caption_color = None

    visibility = request.form.get("visibility", "public")
    if visibility not in ("public", "followers", "close_friends"):
        visibility = "public"

    # `caption` sütunu türetilir: istemci boş gönderip overlay_elements içinde
    # "text" katman(lar)ı VARSA, o katmanların metni "\n" ile birleştirilip
    # caption'a yazılır — story_archive()/storyArchive.js/save_highlight()
    # hâlâ düz `caption`'ı okuyor, çoklu metin katmanı özelliğiyle onlar
    # BOZULMASIN diye (bkz. sql/migration_story_text_overlay_elements.sql
    # dosya başı yorumu, AYNI gerekçe).
    if not caption and overlay_elements:
        text_parts = [el["text"] for el in overlay_elements if el["type"] == "text"]
        if text_parts:
            caption = "\n".join(text_parts)

    # Insert ve anket AYRI try bloklarında — önceki tek blokta, insert
    # BAŞARILI olup anket patlarsa fallback hikayeyi İKİNCİ kez insert
    # ederdi (duplikat). Fallback sadece insert'in kendisi patlarsa
    # (migration'sız ortam: background_color/visibility kolonu yok) çalışır.
    # NOT: caption_style'a BİLEREK dokunulmuyor (yazılmıyor) — web'in
    # composer'ında bu alanı gönderen bir form alanı hiç YOK, stil web'de
    # her zaman overlay_elements'teki ilgili metin katmanının KENDİ `style`
    # alanında taşınıyor (bkz. parse_overlay_elements). Buraya
    # `request.form.get("caption_style")` okuyup yazmak her zaman None
    # yazan, yanıltıcı ölü kod olurdu (code review bulgusu) — native'in
    # api_create_story()'sindeki GERÇEK caller'ı hâlâ geçerli, o rota
    # değişmedi.
    story_data = {
        "user_id": me, "image_url": image_url, "video_url": video_url, "caption": caption,
        "background_color": background_color, "visibility": visibility,
        "caption_position_x": caption_position_x, "caption_position_y": caption_position_y,
        "caption_color": caption_color,
        "overlay_elements": overlay_elements or None,
    }
    try:
        result = sb.table("stories").insert(story_data).execute()
    except Exception as e:
        if "does not exist" not in str(e):
            # Şema eksikliği DIŞINDA bir hata (ağ, RLS, tip uyuşmazlığı vb.)
            # — "eski kolonlarla tekrar dene" yoluna sessizce düşmek burada
            # YANLIŞ: o yol `visibility`'yi hiç yazmıyor, DB varsayılanı
            # `public` olduğu için `close_friends` bekleyen bir hikaye
            # SESSİZCE herkese açık paylaşılırdı (code review bulgusu —
            # gizlilik ihlali). Gerçek hatayı logla, kullanıcıya net
            # başarısızlık göster.
            current_app.logger.error(f"Hikaye insert hatası: {e}")
            return _fail("Hikaye paylaşılamadı.")
        # Buraya yalnızca "kolon yok" (migration henüz uygulanmamış)
        # hatasında düşülür. Yedek yol visibility/overlay_elements/
        # background_color/caption_* alanlarını YAZAMIYOR — bu alanlardan
        # herhangi biri varsayılanından farklı istenmişse (özellikle
        # visibility != public) SESSİZCE düşürmek yerine paylaşımı reddet.
        current_app.logger.error(f"Hikaye insert şeması eksik, eski kolonlara düşülüyor: {e}")
        if visibility != "public" or overlay_elements or background_color or caption_color:
            current_app.logger.error(
                f"Hikaye insert şeması eksikken visibility={visibility!r} / overlay_elements/"
                f"background_color/caption_color istendi — gizlilik/veri kaybını önlemek için "
                "paylaşım reddedildi."
            )
            return _fail("Hikaye paylaşılamadı (özellik henüz aktif değil).")
        try:
            story_data_legacy = {
                "user_id": me, "image_url": image_url, "video_url": video_url, "caption": caption,
            }
            result = sb.table("stories").insert(story_data_legacy).execute()
        except Exception as e2:
            current_app.logger.error(f"Hikaye insert (yedek yol) hatası: {e2}")
            return _fail("Hikaye paylaşılamadı (özellik henüz aktif değil).")

    story_id = result.data[0]["id"] if result.data else None
    if story_id and has_poll:
        try:
            create_poll(sb, poll_options, story_id=story_id,
                        position_x=poll_position_x, position_y=poll_position_y,
                        scale=poll_scale, rotation=poll_rotation)
        except Exception as e:
            current_app.logger.error(f"Hikaye anketi oluşturulamadı (story_id={story_id}): {e}")
            # Hikayenin KENDİSİ zaten başarıyla oluşturuldu (story_id var) —
            # bunu composer'a `error` gibi göstermek istemciyi (bkz.
            # stories.js fetch handler) tekrar denemeye/aynı hikayeyi İKİNCİ
            # kez paylaşmaya sürükleyebilirdi. api_create_story()'deki
            # (native) AYNI `poll_error` deseni burada da: JSON modunda
            # ok:true + poll_error bayrağıyla dönülür, JS'siz form-POST
            # fallback'i (wants_json DEĞİLKEN) davranışı DEĞİŞMEDEN korunur
            # (code review bulgusu).
            if wants_json:
                return jsonify(ok=True, story_id=story_id, poll_error=True)
            flash("Hikaye paylaşıldı ama anket eklenemedi.", "error")
            return redirect(url_for("routes.feed"))

    # @mention sticker bildirimleri — insert SONRASI (poll ile AYNI sıra),
    # hikaye paylaşımını ASLA bloklamaz (dekoratif yan etki). Per-recipient
    # try/except: tek bir alıcıya bildirim gönderimi patlarsa AYNI istekteki
    # diğer alıcılar da sessizce atlanıyordu (code review bulgusu) — artık
    # her alıcı bağımsız, başarısızlık loglanıyor.
    if story_id and story_mention_recipient_ids:
        for recipient_id in story_mention_recipient_ids:
            try:
                notify_story_mention(sb, actor_id=me, recipient_id=recipient_id)
            except Exception as e:
                current_app.logger.error(
                    f"Hikaye mention bildirimi gönderilemedi (story_id={story_id}, "
                    f"recipient_id={recipient_id}): {e}"
                )

    if wants_json:
        return jsonify(ok=True, story_id=story_id)
    flash("Hikaye paylaşıldı.", "success")
    return redirect(url_for("routes.feed"))


@bp.route("/stories/user/<user_id>")
@login_required
@retry_on_connection_error
def user_stories(user_id):
    """Bir kullanıcının aktif hikayelerini JSON döner (hikaye görüntüleyici
    modalı için) — kendi hikayen DEĞİLSE görüntülenince story_views'e
    işlenir (halka rengi için). Her hikayeye (varsa) anket verisini ekler."""
    sb = get_sb()
    me = session["user"]["id"]

    # Engelleme kontrolü: harita yönde olursa olsun bir engelleme varsa boş liste dön
    if user_id != me and is_blocked_either_way(sb, me, user_id):
        return jsonify(username="Bilinmeyen", avatar_url=None, is_mine=False, stories=[])

    now = datetime.now(timezone.utc).isoformat()

    try:
        # user_id select'te ŞART: _visible_story_filter r["user_id"] okur —
        # eksikse close_friends hikayesinde KeyError (500) + sahibi kendi
        # hikayesini göremezdi
        # overlay_elements (ÇOKLU metin/GIF-sticker/mention/hashtag, jsonb
        # dizi) ve caption_style kolonları da select edilir — web composer'ı
        # artık bu alanları kendisi de yazıyor (bkz. create_story()
        # parse_overlay_elements çağrısı), native'in oluşturduğu bir hikaye
        # de aynı SELECT'ten aynı şekilde gelir.
        rows = sb.table("stories").select(
            "id, user_id, image_url, video_url, caption, created_at, visibility, background_color, "
            "caption_position_x, caption_position_y, caption_style, caption_color, overlay_elements"
        ).eq("user_id", user_id).gt("expires_at", now).order("created_at").execute().data
    except Exception:
        rows = []

    # Görünürlük filtresi — close_friends hikayeleri: ben sahibi değilsem ve
    # sahibinin yakın arkadaş listesinde değilsem gizle
    rows = _visible_story_filter(sb, me, rows)

    if user_id != me:
        for r in rows:
            try:
                sb.table("story_views").upsert({"story_id": r["id"], "user_id": me}).execute()
            except Exception:
                pass

    # Her hikayeye anket verisini ekle
    for story in rows:
        attach_story_poll(sb, story, me)

    prof = sb.table("profiles").select("username, avatar_url").eq("id", user_id).execute().data
    prof = prof[0] if prof else {}

    return jsonify(
        username=prof.get("username", "Bilinmeyen"),
        avatar_url=prof.get("avatar_url"),
        is_mine=(user_id == me),
        stories=rows,
    )


@bp.route("/stories/archive")
@login_required
@retry_on_connection_error
def story_archive():
    """Çağıran kullanıcının KENDİ süresi dolmuş (arşivlenmiş) hikayeleri —
    user_stories()'in AKSİNE user_id parametresi YOK, bu kişisel/gizli bir
    liste. Süresi dolan hikayeler artık FİZİKSEL OLARAK SİLİNMİYOR (bkz.
    active_stories_bar()'ın yorumu) — bu satırlar kalıcı olarak burada
    kalır, sahibi save_highlight/delete_story ile kendisi yönetir."""
    sb = get_sb()
    me = session["user"]["id"]
    now = datetime.now(timezone.utc).isoformat()
    try:
        # overlay_elements SELECT'e dahil — aksi halde çoklu metin katmanlı
        # hikayelerin metni arşivde kaybolurdu (bkz. sql/migration_story_
        # text_overlay_elements.sql'in "caption sütunu korunur" notu: yalnızca
        # HİÇ text katmanı yoksa arşiv düz caption'a güvenebilir).
        # limit(100): _cleanup_expired_stories() kaldırıldığı için (bkz.
        # active_stories_bar() yorumu) arşiv artık SINIRSIZ birikiyor —
        # api_story_viewers()'daki AYNI sınırlama gerekçesiyle (code review
        # bulgusu) bir üst sınır konuldu; tam cursor/sayfalama bu ölçekte
        # (küçük kullanıcı grubu) gereksiz bir erken optimizasyon olurdu.
        rows = sb.table("stories").select(
            "id, user_id, image_url, video_url, caption, created_at, expires_at, visibility, "
            "background_color, caption_position_x, caption_position_y, caption_style, caption_color, "
            "overlay_elements"
        ).eq("user_id", me).lte("expires_at", now).order("created_at", desc=True).limit(100).execute().data
    except Exception:
        rows = []
    return jsonify(stories=rows)


@bp.route("/stories/<story_id>/react", methods=["POST"])
@login_required
@retry_on_connection_error
def react_to_story(story_id):
    """Hikayeye emoji tepkisi — Instagram deseni: hikaye sahibine hem hafif
    bir bildirim (zil, kullanıcı ayarından kapatılabilir) HEM DE tepkinin
    kendisi hikayenin görseliyle birlikte DM olarak gider (reply_to_story ile
    AYNI desen) — kullanıcı isteği: "hikayeye verilen tepkiler sohbete
    gelsin, instagramdaki gibi". Tepki ayrıca bir tabloda TUTULMAZ (hikaye
    24 saatte silinirse tepki de kaybolur), DM mesajı kalıcı iz bırakır."""
    sb = get_sb()
    me = session["user"]["id"]
    emoji = request.form.get("emoji", "").strip()

    # İzin verilen emoji'ler (Instagram'ın hızlı tepki seti)
    allowed_emojis = {"❤️", "😂", "😮", "😢", "🔥", "👏"}
    if emoji not in allowed_emojis:
        return jsonify(error="Geçersiz emoji."), 400

    # Hikayeyi fetch et
    story = sb.table("stories").select("user_id, expires_at, image_url").eq("id", story_id).execute().data
    if not story:
        return jsonify(error="Hikaye bulunamadı."), 404

    owner_id = story[0]["user_id"]
    expires_at = story[0]["expires_at"]

    # Kendi hikayene tepki veremezsin
    if owner_id == me:
        return jsonify(error="Kendi hikayene tepki veremezsin."), 400

    # Engelleme kontrolü: hangi yönde olursa olsun bir engelleme varsa tepki reddedilir
    if is_blocked_either_way(sb, me, owner_id):
        return jsonify(error="Bu kullanıcının hikayesine tepki veremezsin."), 403

    # Süresi dolmuş hikaye kontrolü
    now = datetime.now(timezone.utc).isoformat()
    if expires_at < now:
        return jsonify(error="Süresi dolmuş hikayeye tepki veremezsin."), 410

    # Bildirim oluştur (zil — ayrı bir ayar/toggle'ı var, dokunulmadı)
    from .notifications import notify
    notify(sb, recipient_id=owner_id, actor_id=me, type_="story_reaction")

    # Tepkiyi DM'e düşür — reply_to_story ile aynı desen (hikaye görseli
    # bağlam için mesaja iliştirilir)
    conv_id = _get_or_create_conversation(me, owner_id)
    sb.table("messages").insert({
        "conversation_id": conv_id,
        "sender_id": me,
        "content": f"{emoji} Hikayene tepki verdi",
        "image_url": story[0].get("image_url"),
    }).execute()
    _notify_conversation(sb, conv_id, me)

    return jsonify(ok=True, conversation_id=conv_id)


@bp.route("/stories/<story_id>/reply", methods=["POST"])
@login_required
@retry_on_connection_error
def reply_to_story(story_id):
    """Hikayeye yanıt — Instagram deseni: sahibine DM olarak gider, hikayenin
    görseli (varsa) bağlam için mesaja iliştirilir. Kapsam bilinçli dar:
    yorum/beğeni gibi hikayeye özgü bir depolama YOK, doğrudan mevcut
    mesajlaşma sistemine düşer (bkz. dosya başı yorumu)."""
    sb = get_sb()
    me = session["user"]["id"]
    text = (request.get_json(silent=True) or {}).get("text", "").strip()
    if not text:
        return jsonify(error="Yanıt boş olamaz."), 400
    if len(text) > 500:
        return jsonify(error="Yanıt çok uzun."), 400

    story = sb.table("stories").select("user_id, image_url").eq("id", story_id).execute().data
    if not story:
        return jsonify(error="Hikaye bulunamadı."), 404
    owner_id = story[0]["user_id"]
    if owner_id == me:
        return jsonify(error="Kendi hikayene yanıt veremezsin."), 400
    if is_blocked_either_way(sb, me, owner_id):
        return jsonify(error="Bu kullanıcıya mesaj gönderemezsin."), 403

    conv_id = _get_or_create_conversation(me, owner_id)
    reply_text = f"↩️ Hikayene yanıt:\n{text}"
    sb.table("messages").insert({
        "conversation_id": conv_id,
        "sender_id": me,
        "content": reply_text,
        "image_url": story[0].get("image_url"),
    }).execute()
    _notify_conversation(sb, conv_id, me)

    return jsonify(ok=True, conversation_id=conv_id)


@bp.route("/stories/<story_id>/delete", methods=["POST"])
@login_required
@retry_on_connection_error
def delete_story(story_id):
    sb = get_sb()
    me = session["user"]["id"]
    sb.table("stories").delete().eq("id", story_id).eq("user_id", me).execute()

    if request.headers.get("X-Requested-With") == "fetch":
        return jsonify(ok=True)
    return redirect(url_for("routes.feed"))


def _get_highlights(sb, user_id: str) -> list[dict]:
    """Bir kullanıcının highlight'larını (id, title, cover_url, item_count) döner.

    Profil sayfası server-render'ı ve JS'teki "mevcut highlight'a ekle"
    picker'ı bu helper'ı ortak kullanır."""
    try:
        rows = sb.table("story_highlights").select(
            "id, title, cover_url, story_highlight_items(count)"
        ).eq("user_id", user_id).order("created_at").execute().data
    except Exception:
        return []  # migration henüz uygulanmamışsa boş liste, sayfa kırılmaz
    for r in rows:
        counts = r.pop("story_highlight_items", None)
        r["item_count"] = counts[0]["count"] if counts else 0
    return rows


@bp.route("/stories/<story_id>/save-highlight", methods=["POST"])
@login_required
@retry_on_connection_error
def save_highlight(story_id):
    """Bir hikayeyi mevcut bir highlight'a ekler veya yeni highlight
    oluşturup ekler. Body: {"highlight_id": ...} XOR {"new_title": ...}."""
    sb = get_sb()
    me = session["user"]["id"]
    body = request.get_json(silent=True) or {}
    highlight_id = body.get("highlight_id")
    new_title = body.get("new_title")

    if not highlight_id and not new_title:
        return jsonify(error="highlight_id veya new_title gerekli."), 400
    if new_title is not None and not new_title.strip():
        return jsonify(error="Başlık boş olamaz."), 400

    story = sb.table("stories").select(
        "image_url, video_url, caption, created_at, user_id"
    ).eq("id", story_id).execute().data
    if not story:
        return jsonify(error="Hikaye bulunamadı."), 404
    story = story[0]
    if story["user_id"] != me:
        return jsonify(error="Sadece kendi hikayeni öne çıkarabilirsin."), 403

    try:
        if highlight_id:
            hl = sb.table("story_highlights").select("id, user_id").eq(
                "id", highlight_id
            ).execute().data
            if not hl:
                return jsonify(error="Highlight bulunamadı."), 404
            if hl[0]["user_id"] != me:
                return jsonify(error="Başkasının highlight'ına ekleyemezsin."), 403
        else:
            created = sb.table("story_highlights").insert({
                "user_id": me, "title": new_title.strip(), "cover_url": story["image_url"],
            }).execute().data
            highlight_id = created[0]["id"]

        # Hikayenin medyasını KOPYALA — orijinal hikaye (24 saatte) silinse
        # bile highlight kalıcı kalmalı, bu yüzden stories.id'ye FK verilmez.
        sb.table("story_highlight_items").insert({
            "highlight_id": highlight_id,
            "image_url": story["image_url"],
            "video_url": story["video_url"],
            "caption": story["caption"],
            "original_created_at": story["created_at"],
        }).execute()
    except Exception:
        return jsonify(error="Öne çıkanlar özelliği henüz aktif değil."), 503

    return jsonify(ok=True, highlight_id=highlight_id)


@bp.route("/stories/highlights/<user_id>")
@login_required
@retry_on_connection_error
def get_highlights(user_id):
    sb = get_sb()
    me = session["user"]["id"]

    # Engelleme kontrolü: hangi yönde olursa olsun bir engelleme varsa boş liste dön
    if user_id != me and is_blocked_either_way(sb, me, user_id):
        return jsonify(highlights=[])

    return jsonify(highlights=_get_highlights(sb, user_id))


@bp.route("/stories/highlights/<highlight_id>/view")
@login_required
@retry_on_connection_error
def view_highlight(highlight_id):
    sb = get_sb()
    me = session["user"]["id"]
    try:
        hl = sb.table("story_highlights").select("id, user_id, title").eq(
            "id", highlight_id
        ).execute().data
        if not hl:
            return jsonify(error="Highlight bulunamadı."), 404

        # Engelleme kontrolü: hangi yönde olursa olsun bir engelleme varsa 404 dön
        # (enumeration önleme — highlight bulunamazsa da aynı 404)
        if hl[0]["user_id"] != me and is_blocked_either_way(sb, me, hl[0]["user_id"]):
            return jsonify(error="Highlight bulunamadı."), 404

        items = sb.table("story_highlight_items").select(
            "id, image_url, video_url, caption, original_created_at"
        ).eq("highlight_id", highlight_id).order("added_at").execute().data
    except Exception:
        return jsonify(error="Öne çıkanlar özelliği henüz aktif değil."), 503

    return jsonify(title=hl[0]["title"], is_mine=(hl[0]["user_id"] == me), items=items)


@bp.route("/stories/highlights/<highlight_id>/delete", methods=["POST"])
@login_required
@retry_on_connection_error
def delete_highlight(highlight_id):
    sb = get_sb()
    me = session["user"]["id"]
    try:
        sb.table("story_highlights").delete().eq("id", highlight_id).eq("user_id", me).execute()
    except Exception:
        return jsonify(error="Öne çıkanlar özelliği henüz aktif değil."), 503
    return jsonify(ok=True)
