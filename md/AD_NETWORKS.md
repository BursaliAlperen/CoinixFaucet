# Reklam ağı ve monetizasyon sağlayıcıları

## Aktif entegrasyonlar
- Piarflow: sponsor abonelik kontrolü ve başarılı doğrulama sonrası tek seferlik ödül.
- FlyerHubs: görev listesi ve sağlayıcı doğrulaması sonrası tek seferlik ödül.

API üzerinden doğrulanan Piarflow ve FlyerHubs görev ödülü Coinix tarafında sabit $0.002 olarak ayarlanmıştır. Sağlayıcının yayıncı gelirinin bu tutarı karşıladığı garanti edilmez.

## Traffy
- Mini App sağlayıcı listesinde Traffy yer alır.
- TRAFFY_API_KEY yalnızca backend ortam değişkeninden okunur; tarayıcıya gönderilmez.
- Kullanıcıya özel takip bağlantısı, TRAFFY_LINK_PREFIX ayarlanmışsa https://t.me/Traffy_robot?startapp=l_<prefix>_<telegram_id> biçiminde oluşturulur.
- Gerçek Traffy API senkronizasyonu henüz etkin değildir. Mevcut bağlantı ekranı ve API durum alanı hazırdır; API anahtarı tek başına endpoint/yanıt şeması tanımlamaz.
- Resmî API dokümanı veya çalışan örnek istek/yanıt gelmeden son 24 saatlik kayıtları çekmek, kullanıcı ID/etiket/tutar alanlarını eşlemek ya da bakiye yazmak güvenli değildir.
- Traffy kayıtları şu anda otomatik ödüllendirilmez. Benzersiz event ID alanı doğrulandıktan sonra idempotent kredi etkinleştirilecektir.
- API etkinleştirilirken 300 istek/dakika sınırı, sayfalama ve kontrollü yeniden deneme zorunlu olacaktır.

## Devre dışı
- Monetag entegrasyonu Coinix kaynak kodundan kaldırılmıştır. SDK, postback endpoint'i ve ayarları kullanılmaz.
- Tarayıcı SDK callback'leri tek başına ödül makbuzu kabul edilmez.

## Güvenlik
- Anahtarları GitHub'a, frontend'e, Telegram mesajlarına veya loglara koymayın.
- Sohbette paylaşılmış eski Traffy anahtarını kullanmayın; sağlayıcı panelinden yenisini üretip Railway'deki TRAFFY_API_KEY değişkenine girin.
