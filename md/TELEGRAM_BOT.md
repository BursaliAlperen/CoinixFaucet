# Telegram bot ve üyelik kapısı

## Komutlar
- /start — kanal üyeliğini kontrol eder; katılmayan kullanıcıya kanal ve tekrar kontrol düğmesi sunar.
- /help — yardım.
- /level — seviye, XP ve kazanç çarpanı.
- /referrals — kişisel davet bağlantısı ve davet istatistikleri.
- /admin — yalnızca ADMIN_IDS için yönetim paneli bağlantısı.
- /botstart /botstop — yalnızca yöneticiler için kullanıcı erişimini açar/kapatır.

## Zorunlu kanal
1. Railway'de REQUIRED_CHANNEL_ID ve REQUIRED_CHANNEL_URL tanımla.
2. Botu kanala yönetici olarak ekle.
3. /start ve Mini App /api/session öncesinde üyelik sunucuda kontrol edilir.
4. Katılmayan kullanıcı görev ve kazanç API'lerine erişemez. Buton tekrar kontrol yapar.
5. Telegram API yetki/kanal hataları güvenli şekilde loglanır ve yöneticilere bildirilir.

## Davet ve bonus
1. Bağlantı biçimi: https://t.me/BOT_USERNAME?start=ref_TELEGRAM_ID.
2. İlk kez katılan yeni kullanıcı için referral ilişkisi referralClaims altında bir kez kaydedilir.
3. Davet eden kullanıcıya varsayılan olarak +0.02x ek çarpan tanımlanır; bu yüzde değil, mevcut çarpana eklenen 0.02 çarpan puanıdır.
4. Bonus varsayılan 24 saat aktiftir; startsAt, endsAt, source ve durum saklanır. Süresi geçen bonus kazanç formülünden otomatik çıkar.
5. Admin ayarları referralMultiplierBonus (0–0.25) ve referralBonusDurationHours (1–168) değerlerini yönetir.
