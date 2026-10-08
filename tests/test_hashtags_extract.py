"""extract_hashtags birim testleri: normalizasyon, sınır durumları ve URL fragment regresyonu."""
import pytest
from app.hashtags import extract_hashtags


def test_basit_etiketler_cikar():
    assert extract_hashtags("bugün #python ve #flask öğrendim") == ["python", "flask"]


def test_buyuk_kucuk_harf_birlestirilir_ve_sira_korunur():
    assert extract_hashtags("#Python #python #FLASK #flask") == ["python", "flask"]


def test_turkce_karakterler_calisir():
    assert extract_hashtags("#çalışma #şişe #ğüzel") == ["çalışma", "şişe", "ğüzel"]


def test_buyuk_i_noktasi_bilinen_davranis():
    # Python lower(): "İ" -> "i" + birleşik nokta (2 karakter); #istanbul ile #İstanbul AYRI etiket olur.
    # Bu test mevcut davranışı belgeler; Türkçe İ düzeltmesi yapılırsa burası güncellenir.
    assert extract_hashtags("#İstanbul") == ["i̇stanbul"]


def test_bos_icerik_bos_liste_doner():
    assert extract_hashtags("") == []
    assert extract_hashtags(None) == []


def test_etiketsiz_metin():
    assert extract_hashtags("burada hiç etiket yok") == []


@pytest.mark.parametrize("metin, beklenen", [
    ("#a#b", ["a", "b"]),             # bitişik etiketler
    ("#abc_def", ["abc_def"]),         # alt çizgi etiketin parçası
    ("#abc-def", ["abc"]),             # tire etiketi bitirir
    ("# boşluklu", []),                # tek başına # etiket değil
])
def test_sinir_durumlari(metin, beklenen):
    assert extract_hashtags(metin) == beklenen


def test_url_icindeki_parca_etiket_sayilmamali():
    # https://site.com/sayfa#bolum -> "bolum" bir hashtag DEĞİL, sayfa içi bağlantı
    assert extract_hashtags("bak https://site.com/sayfa#bolum güzel") == []


def test_url_disindaki_etiket_korunur():
    # Aynı metinde hem bağlantı parçası hem gerçek etiket: yalnız gerçek etiket kalır
    assert extract_hashtags("https://x.com/a#kisim bence #python harika") == ["python"]
