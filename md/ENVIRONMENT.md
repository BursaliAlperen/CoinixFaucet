# Ortam değişkenleri ve dağıtım

Railway → CoinixFaucet → Variables bölümünde ayarlayın. Gerçek anahtarları GitHub'a eklemeyin.

| Değişken | Açıklama |
|---|---|
| BOT_TOKEN | BotFather bot tokeni (gizli) |
| BOT_USERNAME | @ olmadan bot adı |
| ADMIN_IDS | Virgülle ayrılmış Telegram yönetici ID'leri |
| BOT_WEBHOOK_SECRET | Telegram webhook doğrulama sırrı |
| PUBLIC_BASE_URL / WEBAPP_URL / APP_ORIGIN | Railway HTTPS adresleri |
| REQUIRED_CHANNEL_ID | Zorunlu kanalın @kullanıcı adı veya -100... ID'si |
| REQUIRED_CHANNEL_URL | Kullanıcının katılacağı HTTPS/T.me bağlantısı |
| FIREBASE_SERVICE_ACCOUNT | Firebase servis hesabı JSON'u (gizli) |
| FIREBASE_DATABASE_URL | Aynı Firebase projesinin RTDB URL'si |
| FIREBASE_WEB_API_KEY / AUTH_DOMAIN / PROJECT_ID / APP_ID | Aynı projedeki Firebase Web App ayarları |
| PIARFLOW_API_KEY | Piarflow gizli API anahtarı |
| FLYERHUBS_KEY | FlyerHubs gizli API anahtarı |
| TRAFFY_API_KEY | Yenilenmiş Traffy gizli API anahtarı; istemci tarafından kullanılmaz |
| TRAFFY_LINK_PREFIX | Traffy kişisel linkindeki l_ öncesi prefix |
| REWARD_TIMEZONE | Varsayılan Europe/Istanbul |
| TELEGRAM_INIT_DATA_MAX_AGE_SECONDS | Mini App initData geçerlilik süresi; varsayılan 86400 |

## Çalıştırma
- Build: npm install
- Start: npm start
- Health: /health
- Node.js: 20+

Zorunlu kanal kontrolünün çalışması için botu hedef kanala yönetici ekleyin. Telegram getChatMember ile diğer kullanıcıların üyeliğini güvenilir biçimde kontrol edebilmek için botun kanalda yönetici olması gerekir.

Firebase Admin servis hesabı, RTDB URL ve Web App ayarlarının tamamı aynı Firebase projesine ait olmalıdır. Eksik Firebase değişkenleri Railway'de doldurulmalıdır.

Traffy API sözleşmesi doğrulanana kadar sağlayıcı durumu awaiting_official_api_contract görünür ve bakiye kredisi yapılmaz.
