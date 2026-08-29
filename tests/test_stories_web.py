"""Web hikaye oluşturma (`POST /stories/new`) testleri.

Eskiden bu route için HİÇ test yoktu (tüm hikaye test kapsamı api_v1
üzerindeydi, bkz. tests/test_api_v1.py). Çoklu metin katmanı + döndürme
özelliğiyle web `parse_overlay_elements()`'i (app/stories.py) api_v1 ile
PAYLAŞTIĞI için, bu dosya özellikle o paylaşımın gerçekten çalıştığını ve
web'e özgü JSON/redirect yanıt dallanmasını (bkz. create_story() docstring'i,
delete_story()'deki AYNI X-Requested-With deseni) doğruluyor.
"""
import json

import pytest

from app.supabase_client import get_sb
from app.stories import parse_overlay_elements


def _cleanup_stories(app, user_id):
    with app.app_context():
        sb = get_sb()
        sb.table("stories").delete().eq("user_id", user_id).execute()


class TestCreateStoryWebJsonMode:
    """`X-Requested-With: fetch` header'ı composer'ın yeni katman editörü
    içindir — redirect yerine JSON döner, CSRF/no-JS fallback davranışı
    BOZULMADAN kalır (delete_story()'deki AYNI desen)."""

    def test_fetch_header_returns_json_not_redirect(self, app, client, logged_in_session):
        user, _ = logged_in_session(
            email="web_story_fetch_json@example.com", password="TestPass123!"
        )
        elements = [{"type": "text", "text": "web'den metin katmanı"}]

        resp = client.post(
            "/stories/new",
            data={
                "csrf_token": "test-csrf-token",
                "overlay_elements": json.dumps(elements),
            },
            headers={"X-Requested-With": "fetch"},
        )
        assert resp.status_code == 200
        assert resp.content_type.startswith("application/json")
        body = resp.get_json()
        assert body["ok"] is True
        assert body["story_id"]

        _cleanup_stories(app, user["id"])

    def test_without_fetch_header_still_redirects(self, app, client, logged_in_session):
        """JS'siz form-POST fallback'i BOZULMAMALI — header yoksa eski
        redirect+flash davranışı aynen sürer."""
        user, _ = logged_in_session(
            email="web_story_no_fetch_header@example.com", password="TestPass123!"
        )

        resp = client.post(
            "/stories/new",
            data={"csrf_token": "test-csrf-token", "caption": "redirect testi"},
        )
        assert resp.status_code == 302

        _cleanup_stories(app, user["id"])

    def test_error_with_fetch_header_returns_json_400_not_redirect(self, app, client, logged_in_session):
        """Boş hikaye + fetch header -> composer state kaybolmasın diye 400
        JSON (302 DEĞİL) — reload olursa sürüklenen katmanlar kaybolurdu."""
        user, _ = logged_in_session(
            email="web_story_fetch_error@example.com", password="TestPass123!"
        )

        resp = client.post(
            "/stories/new",
            data={"csrf_token": "test-csrf-token"},
            headers={"X-Requested-With": "fetch"},
        )
        assert resp.status_code == 400
        assert resp.get_json()["error"]

        _cleanup_stories(app, user["id"])


class TestCreateStoryWebCsrf:
    def test_missing_csrf_token_returns_400(self, app, client, logged_in_session):
        logged_in_session(email="web_story_csrf_missing@example.com", password="TestPass123!")

        resp = client.post("/stories/new", data={"caption": "csrf'siz istek"})
        assert resp.status_code == 400

    def test_invalid_csrf_token_returns_400(self, app, client, logged_in_session):
        logged_in_session(email="web_story_csrf_invalid@example.com", password="TestPass123!")

        resp = client.post(
            "/stories/new",
            data={"csrf_token": "yanlis-token", "caption": "csrf testi"},
        )
        assert resp.status_code == 400


class TestCreateStoryWebOverlayElements:
    """Web composer'ın artık api_v1 ile AYNI parse_overlay_elements()'i
    çağırdığının kanıtı — eskiden web bu alanı hiç okumuyordu."""

    def test_overlay_elements_round_trip_via_web_route(self, app, client, logged_in_session):
        user, _ = logged_in_session(
            email="web_story_overlay_roundtrip@example.com", password="TestPass123!"
        )
        elements = [
            {"type": "text", "text": "web metni", "style": "pill_light", "color": "#27ae60",
             "position_x": 0.3, "position_y": 0.4, "scale": 1.2, "rotation": 30.0},
            {"type": "hashtag", "tag": "#WebParite"},
        ]

        resp = client.post(
            "/stories/new",
            data={
                "csrf_token": "test-csrf-token",
                "overlay_elements": json.dumps(elements),
            },
            headers={"X-Requested-With": "fetch"},
        )
        assert resp.status_code == 200
        story_id = resp.get_json()["story_id"]

        # web'in KENDİ GET /stories/user/<id> uç noktasından oku — api_v1'e
        # DOKUNMADAN, web route'unun paylaşılan parser'ı gerçekten kullandığını
        # kanıtlar.
        fetch = client.get(f"/stories/user/{user['id']}")
        assert fetch.status_code == 200
        story = next(s for s in fetch.get_json()["stories"] if s["id"] == story_id)
        stored = story["overlay_elements"]
        assert len(stored) == 2
        assert stored[0]["type"] == "text"
        assert stored[0]["text"] == "web metni"
        assert stored[0]["style"] == "pill_light"
        assert stored[0]["color"] == "#27ae60"
        assert stored[0]["rotation"] == pytest.approx(30.0)
        assert stored[1]["type"] == "hashtag"
        assert stored[1]["tag"] == "webparite"
        # caption text katmanından türetilmiş olmalı (bkz. create_story()).
        assert story["caption"] == "web metni"

        _cleanup_stories(app, user["id"])

    def test_overlay_elements_capped_at_ten_via_web_route(self, app, client, logged_in_session):
        user, _ = logged_in_session(
            email="web_story_overlay_cap@example.com", password="TestPass123!"
        )
        elements = [{"type": "hashtag", "tag": f"etiket{i}"} for i in range(12)]

        resp = client.post(
            "/stories/new",
            data={"csrf_token": "test-csrf-token", "overlay_elements": json.dumps(elements)},
            headers={"X-Requested-With": "fetch"},
        )
        assert resp.status_code == 200
        story_id = resp.get_json()["story_id"]

        fetch = client.get(f"/stories/user/{user['id']}")
        story = next(s for s in fetch.get_json()["stories"] if s["id"] == story_id)
        assert len(story["overlay_elements"]) == 10

        _cleanup_stories(app, user["id"])


class TestStoryArchiveWebIncludesOverlayElements:
    def test_archive_select_includes_overlay_elements(self, app, client, logged_in_session):
        """Regresyon guard'ı — story_archive() SELECT'ine overlay_elements
        eklenmezse çoklu metin katmanlı hikayelerin metni arşivde kaybolurdu."""
        user, _ = logged_in_session(
            email="web_story_archive_overlay@example.com", password="TestPass123!"
        )

        with app.app_context():
            sb = get_sb()
            # Süresi ÇOKTAN dolmuş bir hikaye — story_archive() sadece
            # bunları döner (expires_at <= now).
            sb.table("stories").insert({
                "user_id": user["id"],
                "caption": "arşiv testi",
                "overlay_elements": [{"type": "text", "text": "arşiv testi",
                                       "position_x": 0.5, "position_y": 0.75,
                                       "scale": 1.0, "rotation": 0.0}],
                "expires_at": "2000-01-01T00:00:00+00:00",
            }).execute()

        resp = client.get("/stories/archive")
        assert resp.status_code == 200
        stories = resp.get_json()["stories"]
        matching = [s for s in stories if s["caption"] == "arşiv testi"]
        assert matching, "arşiv listesinde test hikayesi bulunamadı"
        assert matching[0]["overlay_elements"] is not None
        assert matching[0]["overlay_elements"][0]["type"] == "text"

        _cleanup_stories(app, user["id"])


class TestParseOverlayElementsUnit:
    """`parse_overlay_elements()` doğrudan çağrı — clamp/cap/rotation
    davranışını route'lardan BAĞIMSIZ doğrular (sb=None geçilebilir çünkü
    hiçbir test burada mention doğrulaması tetiklemiyor)."""

    def test_rotation_is_normalized_modulo_360(self):
        raw = json.dumps([
            {"type": "hashtag", "tag": "a", "rotation": 400.0},
            {"type": "hashtag", "tag": "b", "rotation": -10.0},
        ])
        elements, _ = parse_overlay_elements(None, raw, me="00000000-0000-0000-0000-000000000000")
        assert elements[0]["rotation"] == pytest.approx(40.0)
        # Python'da -10.0 % 360.0 == 350.0 (matematiksel modulo, negatif kalan değil)
        assert elements[1]["rotation"] == pytest.approx(350.0)

    def test_cap_is_ten_regardless_of_type_mix(self):
        raw = json.dumps(
            [{"type": "hashtag", "tag": f"h{i}"} for i in range(6)]
            + [{"type": "text", "text": f"t{i}"} for i in range(6)]
        )
        elements, _ = parse_overlay_elements(None, raw, me="00000000-0000-0000-0000-000000000000")
        assert len(elements) == 10

    def test_malformed_json_returns_empty(self):
        elements, mentions = parse_overlay_elements(None, "{not valid json[", me="x")
        assert elements == []
        assert mentions == set()

    def test_none_raw_returns_empty(self):
        elements, mentions = parse_overlay_elements(None, None, me="x")
        assert elements == []
        assert mentions == set()
