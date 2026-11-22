# CoinixFaucet

Telegram botu + mobil uyumlu Telegram Mini App + ayrı yönetim paneli.

## Teknoloji
- Node.js 20+, yerleşik HTTP sunucusu
- Firebase Realtime Database (profiller, görevler, davetler, çekimler)
- Firestore (işlem defteri)
- Telegram Bot API + Mini App initData doğrulaması
- HTML/CSS/Vanilla JavaScript; yerel SVG ikon sprite sistemi

## Güvenlik ve ekonomi
- Zorunlu kanal üyeliği getChatMember ile sunucuda doğrulanır.
- Görev ödülleri sunucu doğrulamasından sonra yazılır; claim kayıtları tekrar ödemeyi engeller.
- Davet bonusu USD nakit değildir: mevcut seviye çarpanına +0.02x eklenir, varsayılan 24 saat sürer.
- Piarflow/FlyerHubs API görev ödülleri $0.002 sabittir.
- Traffy link oluşturma ve sağlayıcı durumu hazırdır; gerçek API senkronizasyonu resmî sözleşme gelene kadar kapalıdır.
- Monetag kaldırılmıştır.
- Çekimler yalnızca TON ve GRAM; admin paneli gerçek gönderimden sonra tx hash kaydeder. Otomatik blockchain transferi yoktur.

## Kurulum
1. Railway değişkenlerini md/ENVIRONMENT.md dosyasına göre ayarla.
2. Botu zorunlu kanala yönetici ekle; REQUIRED_CHANNEL_ID ve REQUIRED_CHANNEL_URL gir.
3. Firebase servis hesabı, RTDB URL ve Web App ayarlarının aynı projeden geldiğini doğrula.
4. Önce dry-run, sonra RUN_MIGRATION=1 npm run migrate:v3 ile geriye uyumlu migration uygula.
5. npm run check çalıştır; ardından Railway deploy ve /health kontrolü yap.
6. Telegram'da /start ile kanal kapısını; yönetici hesabında /admin ile paneli test et.

## Yönetici
- ADMIN_IDS ile yetkilendirme.
- /botstart ve /botstop kullanıcı erişimini etkinleştirir/duraklatır.
- Panelden görev oluşturma, durum değiştirme, manuel kanıt onayı, çekim ve istatistikler.
- Önemli yönetici işlemleri adminAudit düğümüne kaydedilir.

## Dış servislerde bekleyenler
- Zorunlu kanal bilgileri ve Firebase ortam değerleri Railway'e girilmelidir.
- Traffy resmî API dokümanı veya çalışan örnek istek/yanıtı gereklidir; bu olmadan endpoint uydurulmaz ve kredi verilmez.
- Eski Traffy anahtarı kullanılmamalı; yenisi sağlayıcı panelinden üretilmelidir.
