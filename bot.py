"""
Coinix Telegram Bot (Python)
=============================
Bu bot, Coinix Faucet uygulamasının Telegram tarafıdır.

Sorumlulukları:
- /start komutu: Hoşgeldin mesajı + "Open App" butonu + bot hakkında bilgi
- Referral sistemi: /start ref_<userId> ile davet
- Inaktif kullanıcı mesajı: 1-3 gün bota girmeyen kullanıcılara
  "We missed you 💜" mesajı (her kullanıcıya en fazla 1 kez)
- Admin broadcast: Admin belirli bir komutla tüm kullanıcılara mesaj gönderebilir

NOT: Bu dosya sadece Telegram bot tarafıdır. Web uygulaması (Express + Firestore)
ayrı çalışır. Bu bot, kullanıcı etkileşim bilgilerini Firestore'a yazar,
böylece web uygulamasıyla senkronize çalışır.

Kurulum:
    pip install aiogram>=3.4 firebase-admin
    # .env dosyası:
    BOT_TOKEN=123456:ABC...
    BOT_USERNAME=CoinixBot
    APP_URL=https://coinix-faucet.vercel.app
    FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
    ADMIN_TELEGRAM_ID=123456789
"""

import asyncio
import logging
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

try:
    from aiogram import Bot, Dispatcher, F, types
    from aiogram.enums import ParseMode
    from aiogram.filters import Command, CommandObject, CommandStart
    from aiogram.fsm.context import FSMContext
    from aiogram.fsm.state import State, StatesGroup
    from aiogram.fsm.storage.memory import MemoryStorage
    from aiogram.types import (
        InlineKeyboardButton,
        InlineKeyboardMarkup,
        KeyboardButton,
        ReplyKeyboardMarkup,
        WebAppInfo,
    )
except ImportError:
    print("aiogram yüklü değil. Kurmak için: pip install aiogram>=3.4", file=sys.stderr)
    raise

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
except ImportError:
    print("firebase-admin yüklü değil. Kurmak için: pip install firebase-admin", file=sys.stderr)
    raise

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


# ============================================================
# CONFIG
# ============================================================
BOT_TOKEN = os.getenv("BOT_TOKEN")
BOT_USERNAME = os.getenv("BOT_USERNAME", "CoinixBot")
APP_URL = os.getenv("APP_URL", "https://coinix-faucet.vercel.app")
ADMIN_TELEGRAM_ID = os.getenv("ADMIN_TELEGRAM_ID", "")

# Inaktif mesaj eşikleri (saniye)
INACTIVE_THRESHOLD_DAYS = 3  # 3 günden fazla girmezse "miss you" mesajı
INACTIVE_CHECK_INTERVAL_HOURS = 6  # her 6 saatte bir kontrol

# Günlük inaktif mesaj kotası (rate limit koruması)
INACTIVE_DAILY_BATCH = 200

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN env variable is required")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("coinix-bot")


# ============================================================
# FIREBASE INIT
# ============================================================
db: Optional[firestore.Client] = None
firestore_available = False

_firebase_service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
_firebase_service_account_base64 = os.getenv("FIREBASE_SERVICE_ACCOUNT_BASE64")
_firebase_service_account_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "serviceAccountKey.json")

try:
    if not firebase_admin._apps:
        if _firebase_service_account_json:
            import json
            sa_info = json.loads(_firebase_service_account_json)
            cred = credentials.Certificate(sa_info)
            firebase_admin.initialize_app(cred)
            logger.info("Firebase initialized from FIREBASE_SERVICE_ACCOUNT_JSON")
        elif _firebase_service_account_base64:
            import base64, json
            decoded = base64.b64decode(_firebase_service_account_base64).decode("utf-8")
            sa_info = json.loads(decoded)
            cred = credentials.Certificate(sa_info)
            firebase_admin.initialize_app(cred)
            logger.info("Firebase initialized from FIREBASE_SERVICE_ACCOUNT_BASE64")
        elif os.path.exists(_firebase_service_account_path):
            cred = credentials.Certificate(_firebase_service_account_path)
            firebase_admin.initialize_app(cred)
            logger.info(f"Firebase initialized from {_firebase_service_account_path}")
        else:
            logger.warning("Firebase credentials not found, bot will run without DB")
    db = firestore.client()
    firestore_available = True
except Exception as e:
    logger.error(f"Firebase init failed: {e}")
    firestore_available = False


# ============================================================
# BOT INIT
# ============================================================
bot = Bot(token=BOT_TOKEN, parse_mode=ParseMode.HTML)
storage = MemoryStorage()
dp = Dispatcher(storage=storage)


# ============================================================
# LOCAL FALLBACK (Firebase yoksa)
# ============================================================
# Firebase bağlanamadığında kullanıcı verilerini RAM'de tutmak için
# minimal bir fallback. Production'da her zaman Firebase kullan.
_LOCAL_USERS: dict[int, dict] = {}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


async def upsert_user(telegram_user: types.User, referrer_id: Optional[int] = None):
    """Kullanıcıyı Firestore'a kaydet (veya RAM'de güncelle)."""
    uid = telegram_user.id
    now = _now_utc()
    payload = {
        "user_id": uid,
        "username": telegram_user.username or "",
        "first_name": telegram_user.first_name or "",
        "last_name": telegram_user.last_name or "",
        "language_code": telegram_user.language_code or "en",
        "is_bot": telegram_user.is_bot,
        "last_seen": now,
        "last_seen_iso": _iso(now),
        "last_miss_you_sent": None,
        "updated_at": now,
    }

    if firestore_available and db:
        try:
            user_ref = db.collection("bot_users").document(str(uid))
            snap = user_ref.get()
            is_new = not snap.exists
            if is_new:
                payload.update({
                    "created_at": now,
                    "joined_via": "telegram_bot",
                    "referrer_id": referrer_id,
                    "is_admin": (str(uid) == str(ADMIN_TELEGRAM_ID)),
                })
            else:
                existing = snap.to_dict() or {}
                payload["created_at"] = existing.get("created_at", now)
                payload["joined_via"] = existing.get("joined_via", "telegram_bot")
                payload["referrer_id"] = existing.get("referrer_id", referrer_id)
                payload["is_admin"] = (str(uid) == str(ADMIN_TELEGRAM_ID))
                payload["miss_you_sent_count"] = existing.get("miss_you_sent_count", 0)

            # increment_start_count
            updates = dict(payload)
            updates["start_count"] = firestore.Increment(1) if is_new else firestore.Increment(1)
            user_ref.set(updates, merge=True)
            return is_new
        except Exception as e:
            logger.error(f"Firebase upsert_user error: {e}")

    # Fallback: RAM
    is_new = uid not in _LOCAL_USERS
    if is_new:
        _LOCAL_USERS[uid] = {
            **payload,
            "created_at": now,
            "joined_via": "telegram_bot",
            "referrer_id": referrer_id,
            "is_admin": (str(uid) == str(ADMIN_TELEGRAM_ID)),
            "start_count": 1,
            "miss_you_sent_count": 0,
        }
    else:
        _LOCAL_USERS[uid].update(payload)
        _LOCAL_USERS[uid]["start_count"] = _LOCAL_USERS[uid].get("start_count", 0) + 1
    return is_new


async def mark_active(telegram_id: int):
    """Kullanıcının last_seen alanını şimdi olarak güncelle."""
    now = _now_utc()
    if firestore_available and db:
        try:
            db.collection("bot_users").document(str(telegram_id)).set({
                "last_seen": now,
                "last_seen_iso": _iso(now),
                "updated_at": now,
            }, merge=True)
            return
        except Exception as e:
            logger.error(f"Firebase mark_active error: {e}")
    if telegram_id in _LOCAL_USERS:
        _LOCAL_USERS[telegram_id]["last_seen"] = now
        _LOCAL_USERS[telegram_id]["last_seen_iso"] = _iso(now)


async def mark_miss_you_sent(telegram_id: int):
    """Kullanıcıya miss-you mesajı gönderildi olarak işaretle."""
    now = _now_utc()
    if firestore_available and db:
        try:
            db.collection("bot_users").document(str(telegram_id)).set({
                "last_miss_you_sent": now,
                "miss_you_sent_count": firestore.Increment(1),
                "updated_at": now,
            }, merge=True)
            return
        except Exception as e:
            logger.error(f"Firebase mark_miss_you error: {e}")
    if telegram_id in _LOCAL_USERS:
        _LOCAL_USERS[telegram_id]["last_miss_you_sent"] = now
        _LOCAL_USERS[telegram_id]["miss_you_sent_count"] = _LOCAL_USERS[telegram_id].get("miss_you_sent_count", 0) + 1


async def fetch_inactive_users(days_threshold: int, limit: int):
    """
    Son N gün içinde aktif olmayan kullanıcıları getir.
    last_miss_you_sent alanı boş olanları tercih eder (tek seferlik).
    """
    if not firestore_available or not db:
        return []

    cutoff = _now_utc() - timedelta(days=days_threshold)
    sent_cutoff = _now_utc() - timedelta(days=days_threshold)  # aynı eşik

    results = []
    try:
        users_ref = db.collection("bot_users")
        # last_seen < cutoff
        query = users_ref.where("last_seen", "<", cutoff).limit(limit)
        docs = query.stream()
        for doc in docs:
            data = doc.to_dict() or {}
            data["_id"] = doc.id
            # Eğer daha önce miss_you gönderdiyse ve aradan yeterli süre geçtiyse
            # burada basitçe "daha önce hiç gönderilmemiş" olanları alalım
            if not data.get("last_miss_you_sent"):
                results.append(data)
        return results
    except Exception as e:
        logger.error(f"fetch_inactive_users error: {e}")
        return []


# ============================================================
# KEYBOARDS
# ============================================================
def main_menu_keyboard() -> InlineKeyboardMarkup:
    """Start sonrası gösterilen ana butonlar."""
    return InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(
                text="🚀 Open App",
                web_app=WebAppInfo(url=APP_URL),
            )
        ],
        [
            InlineKeyboardButton(text="ℹ️ About Bot", callback_data="about_bot"),
            InlineKeyboardButton(text="👥 Community", url="https://t.me/CoinixCommunity"),
        ],
        [
            InlineKeyboardButton(text="💎 Earn CNX", callback_data="earn"),
            InlineKeyboardButton(text="🎁 Promo Codes", callback_data="promo"),
        ],
        [
            InlineKeyboardButton(text="📊 My Stats", callback_data="mystats"),
            InlineKeyboardButton(text="❓ Help", callback_data="help"),
        ],
    ])


def back_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="⬅️ Back to Menu", callback_data="back_main")]
    ])


def goto_app_keyboard() -> InlineKeyboardMarkup:
    """Tek başına Open App butonu."""
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🚀 Go to App", web_app=WebAppInfo(url=APP_URL))]
    ])


# ============================================================
# TEXT MESSAGES (English)
# ============================================================
WELCOME_NEW = (
    "👋 <b>Welcome to Coinix!</b>\n\n"
    "🎉 You just joined the most rewarding crypto faucet bot on Telegram.\n\n"
    "Here you can earn <b>DOGE</b> and <b>CNX</b> coins by completing simple tasks, "
    "claiming free faucets, using promo codes, and inviting friends.\n\n"
    "💎 <b>What you can do:</b>\n"
    "• Free Faucet every 3 minutes\n"
    "• Complete offers & shortlinks\n"
    "• Play games & PTC ads\n"
    "• Use promo codes for bonuses\n"
    "• Earn 20% referral commission forever\n\n"
    "🚀 Tap the button below to open the app and start earning right now!"
)

WELCOME_BACK = (
    "👋 <b>Welcome back to Coinix!</b>\n\n"
    "🔥 Glad to see you again. Your balance and tasks are waiting.\n\n"
    "🚀 Tap below to jump back in:"
)

REFERRAL_BONUS_NOTE = (
    "\n\n🎁 <i>You were invited by a friend! They will receive a 20% bonus on your earnings.</i>"
)

ABOUT_BOT = (
    "ℹ️ <b>About Coinix Bot</b>\n\n"
    "Coinix is a multi-crypto faucet & earning platform built on Telegram.\n\n"
    "🪙 <b>Supported Coins:</b>\n"
    "• <b>DOGE</b> – Dogecoin\n"
    "• <b>CNX</b> – Coinix Token (internal)\n\n"
    "💸 <b>Earn methods:</b>\n"
    "• Faucet (free, every 3 minutes)\n"
    "• Offerwall tasks & surveys\n"
    "• Shortlinks\n"
    "• PTC ads\n"
    "• Games\n"
    "• Promo codes\n"
    "• 20% referral commission\n\n"
    "🔐 <b>Security:</b>\n"
    "• Telegram-verified sessions\n"
    "• Encrypted API (JWT)\n"
    "• Cloud Firestore database\n\n"
    "🌐 <b>Community:</b> @CoinixCommunity\n"
    "📩 <b>Support:</b> @CoinixSupport"
)

HELP_TEXT = (
    "❓ <b>How to use Coinix Bot</b>\n\n"
    "1️⃣ Tap <b>🚀 Open App</b> to launch the mini app\n"
    "2️⃣ Claim your free faucet every 3 minutes\n"
    "3️⃣ Complete offers & shortlinks for bigger rewards\n"
    "4️⃣ Enter promo codes in the <b>Earn Zone</b>\n"
    "5️⃣ Invite friends with your referral link for 20% lifetime commission\n"
    "6️⃣ Withdraw your balance once you hit the minimum threshold\n\n"
    "📌 Commands:\n"
    "/start – Open main menu\n"
    "/app – Launch the mini app\n"
    "/balance – Quick balance shortcut\n"
    "/promo – How to use promo codes\n"
    "/referral – Get your referral link\n"
    "/help – Show this help\n"
    "/about – About this bot"
)

EARN_TEXT = (
    "💎 <b>Earn CNX & DOGE</b>\n\n"
    "There are many ways to earn inside the app:\n\n"
    "🚰 <b>Faucet</b> – Free coins every 3 minutes\n"
    "📋 <b>Tasks</b> – Complete offers & surveys\n"
    "🔗 <b>Shortlinks</b> – Watch short links for rewards\n"
    "🖼 <b>PTC Ads</b> – View ads and earn\n"
    "🎮 <b>Games</b> – Play & win\n"
    "🎁 <b>Promo Codes</b> – Use codes for bonus coins\n\n"
    "👥 <b>Referrals</b> – 20% lifetime commission\n\n"
    "🚀 Open the app to start:"
)

PROMO_HOWTO = (
    "🎁 <b>Promo Codes</b>\n\n"
    "Promo codes give you free coins. We drop them on our community channels "
    "and during special events.\n\n"
    "📌 <b>How to use:</b>\n"
    "1. Open the app\n"
    "2. Go to <b>Earn Zone → Promo Codes</b>\n"
    "3. Enter the code\n"
    "4. Coins are instantly added to your balance\n\n"
    "⚠️ Each code has a usage limit and expiry date. Use them before they run out!"
)

MISS_YOU_MESSAGES = [
    (
        "💜 <b>We missed you!</b>\n\n"
        "It's been a few days since your last visit. Your free faucet is waiting "
        "and there are new offers to complete.\n\n"
        "🚀 Come back and claim your rewards:"
    ),
    (
        "👋 <b>Hey, come back!</b>\n\n"
        "Your CNX & DOGE balance is waiting for you. Daily tasks reset every 24 hours, "
        "so don't miss out!\n\n"
        "🎁 Tap below to open the app:"
    ),
    (
        "🌟 <b>Your daily rewards are ready</b>\n\n"
        "Faucet, tasks, shortlinks and new promo codes await. "
        "It only takes a minute a day to stack up coins.\n\n"
        "💎 See you inside:"
    ),
    (
        "🔥 <b>Don't leave money on the table!</b>\n\n"
        "You've been away for a few days. Your balance, tasks and referral earnings "
        "are all still there.\n\n"
        "⚡ Open the app now:"
    ),
]


# ============================================================
# HANDLERS
# ============================================================

@dp.message(CommandStart(deep_link=True))
@dp.message(CommandStart())
async def cmd_start(message: types.Message, command: CommandObject):
    """/start komutu — referral destekli."""
    user = message.from_user
    if not user:
        return

    # Referral parse: /start ref_<referrer_id>
    referrer_id: Optional[int] = None
    if command.args and command.args.startswith("ref_"):
        try:
            referrer_id = int(command.args.replace("ref_", "").strip())
            if referrer_id == user.id:
                referrer_id = None  # self-referral engeli
        except ValueError:
            referrer_id = None

    is_new = await upsert_user(user, referrer_id=referrer_id)

    text = (WELCOME_NEW if is_new else WELCOME_BACK)
    if referrer_id:
        text += REFERRAL_BONUS_NOTE

    await message.answer(text, reply_markup=main_menu_keyboard())

    # Admin log
    if firestore_available and db:
        try:
            db.collection("logs").add({
                "action": "bot_start",
                "user_id": user.id,
                "username": user.username or "",
                "is_new": is_new,
                "referrer_id": referrer_id,
                "timestamp": firestore.SERVER_TIMESTAMP,
            })
        except Exception as e:
            logger.error(f"start log error: {e}")


@dp.message(Command("app"))
async def cmd_app(message: types.Message):
    """/app — direkt mini app'i aç."""
    await mark_active(message.from_user.id)
    await message.answer(
        "🚀 <b>Launching Coinix App...</b>",
        reply_markup=goto_app_keyboard(),
    )


@dp.message(Command("balance"))
async def cmd_balance(message: types.Message):
    """/balance — hızlı bakiye (kullanıcı app'i açmalı)."""
    await mark_active(message.from_user.id)
    await message.answer(
        "💰 <b>Your Balance</b>\n\n"
        "Open the app to see your live DOGE & CNX balance, today's earnings, "
        "and pending withdrawals.",
        reply_markup=goto_app_keyboard(),
    )


@dp.message(Command("promo"))
async def cmd_promo(message: types.Message):
    await mark_active(message.from_user.id)
    await message.answer(PROMO_HOWTO, reply_markup=goto_app_keyboard())


@dp.message(Command("referral"))
async def cmd_referral(message: types.Message):
    user = message.from_user
    if not user:
        return
    await mark_active(user.id)
    link = f"https://t.me/{BOT_USERNAME}?startapp=ref_{user.id}"
    await message.answer(
        "👥 <b>Your Referral Link</b>\n\n"
        f"<code>{link}</code>\n\n"
        "🎁 <b>How it works:</b>\n"
        "• Share your link with friends\n"
        "• They join Coinix through your link\n"
        "• You earn <b>20% lifetime commission</b> on every claim they make\n"
        "• No limit on referrals\n\n"
        "💎 The more friends, the more you earn!",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="📤 Share Link",
                    url=f"https://t.me/share/url?url={link}&text=Join%20Coinix%20and%20earn%20free%20crypto!",
                )
            ],
            [InlineKeyboardButton(text="🚀 Open App", web_app=WebAppInfo(url=APP_URL))],
        ]),
    )


@dp.message(Command("help"))
async def cmd_help(message: types.Message):
    await mark_active(message.from_user.id)
    await message.answer(HELP_TEXT, reply_markup=main_menu_keyboard())


@dp.message(Command("about"))
async def cmd_about(message: types.Message):
    await mark_active(message.from_user.id)
    await message.answer(ABOUT_BOT, reply_markup=back_keyboard())


# ---------- Inline callbacks ----------

@dp.callback_query(F.data == "about_bot")
async def cb_about(call: types.CallbackQuery):
    await mark_active(call.from_user.id)
    await call.message.edit_text(ABOUT_BOT, reply_markup=back_keyboard())
    await call.answer()


@dp.callback_query(F.data == "help")
async def cb_help(call: types.CallbackQuery):
    await mark_active(call.from_user.id)
    await call.message.edit_text(HELP_TEXT, reply_markup=main_menu_keyboard())
    await call.answer()


@dp.callback_query(F.data == "earn")
async def cb_earn(call: types.CallbackQuery):
    await mark_active(call.from_user.id)
    await call.message.edit_text(
        EARN_TEXT,
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🚀 Open Earn Zone", web_app=WebAppInfo(url=APP_URL))],
            [InlineKeyboardButton(text="⬅️ Back to Menu", callback_data="back_main")],
        ]),
    )
    await call.answer()


@dp.callback_query(F.data == "promo")
async def cb_promo(call: types.CallbackQuery):
    await mark_active(call.from_user.id)
    await call.message.edit_text(PROMO_HOWTO, reply_markup=goto_app_keyboard())
    await call.answer()


@dp.callback_query(F.data == "mystats")
async def cb_mystats(call: types.CallbackQuery):
    await mark_active(call.from_user.id)
    # Canlı bakiye için kullanıcıyı app'e yönlendir (orada Firestore'dan çekiliyor)
    await call.message.edit_text(
        "📊 <b>Your Stats</b>\n\n"
        "📈 Detailed stats (balance, today's earnings, claims, referrals) "
        "are available inside the app.\n\n"
        "🚀 Tap below:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="📊 Open My Stats", web_app=WebAppInfo(url=APP_URL))],
            [InlineKeyboardButton(text="⬅️ Back to Menu", callback_data="back_main")],
        ]),
    )
    await call.answer()


@dp.callback_query(F.data == "back_main")
async def cb_back_main(call: types.CallbackQuery):
    await mark_active(call.from_user.id)
    await call.message.edit_text(
        WELCOME_BACK,
        reply_markup=main_menu_keyboard(),
    )
    await call.answer()


# ---------- Admin: Broadcast ----------

@dp.message(Command("broadcast"))
async def cmd_broadcast(message: types.Message):
    """Admin tüm kullanıcılara mesaj göndersin."""
    user = message.from_user
    if not user or str(user.id) != str(ADMIN_TELEGRAM_ID):
        return

    text = (message.text or "").replace("/broadcast", "", 1).strip()
    if not text:
        await message.answer(
            "📢 <b>Broadcast usage:</b>\n"
            "<code>/broadcast Your message here</code>",
        )
        return

    if not firestore_available or not db:
        await message.answer("❌ Firebase unavailable, can't fetch user list.")
        return

    sent = failed = 0
    try:
        users_ref = db.collection("bot_users").stream()
        for doc in users_ref:
            data = doc.to_dict() or {}
            uid = data.get("user_id")
            if not uid:
                continue
            try:
                await bot.send_message(uid, f"📢 <b>Announcement</b>\n\n{text}")
                sent += 1
                await asyncio.sleep(0.05)  # Telegram rate limit koruması
            except Exception as e:
                failed += 1
                logger.warning(f"broadcast send fail {uid}: {e}")
    except Exception as e:
        logger.error(f"broadcast error: {e}")
        await message.answer(f"❌ Broadcast error: {e}")
        return

    await message.answer(f"✅ Broadcast done.\n📤 Sent: {sent}\n❌ Failed: {failed}")


@dp.message(Command("stats"))
async def cmd_stats(message: types.Message):
    """Admin için kullanıcı sayısı."""
    user = message.from_user
    if not user or str(user.id) != str(ADMIN_TELEGRAM_ID):
        return

    if not firestore_available or not db:
        count = len(_LOCAL_USERS)
        await message.answer(f"📊 Local users (RAM only): <b>{count}</b>")
        return

    try:
        users_count = len(list(db.collection("bot_users").stream()))
        await message.answer(f"📊 Total bot users: <b>{users_count}</b>")
    except Exception as e:
        await message.answer(f"❌ Stats error: {e}")


# ---------- Catch-all (DM'de her şeyi yakala) ----------

@dp.message()
async def fallback(message: types.Message):
    """Bota gelen her mesajı yakala: last_seen güncelle, menü göster."""
    user = message.from_user
    if not user:
        return
    if user.is_bot:
        return
    # Bot komutu olmayan metin mesajları için de aktif olarak işaretle
    await mark_active(user.id)
    await message.answer(
        "👋 <b>Hey there!</b>\n\n"
        "Use the menu below or type /help to see what I can do.",
        reply_markup=main_menu_keyboard(),
    )


# ============================================================
# BACKGROUND JOB: INACTIVE USERS
# ============================================================
async def miss_you_job():
    """
    Her 6 saatte bir çalışır. 1-3 gündür bota gelmeyen kullanıcılara
    "We missed you" mesajı gönderir. Her kullanıcıya sadece bir kez
    (last_miss_you_sent boş olanlar) gönderilir.
    """
    while True:
        try:
            await asyncio.sleep(INACTIVE_CHECK_INTERVAL_HOURS * 3600)
            logger.info("[miss_you_job] Running inactivity check...")

            if not firestore_available or not db:
                logger.warning("[miss_you_job] Firebase not available, skipping.")
                continue

            users = await fetch_inactive_users(
                days_threshold=INACTIVE_THRESHOLD_DAYS,
                limit=INACTIVE_DAILY_BATCH,
            )
            logger.info(f"[miss_you_job] Found {len(users)} inactive users.")

            for user_data in users:
                uid = user_data.get("user_id")
                if not uid:
                    continue
                try:
                    msg = random.choice(MISS_YOU_MESSAGES)
                    await bot.send_message(
                        uid,
                        msg,
                        reply_markup=goto_app_keyboard(),
                    )
                    await mark_miss_you_sent(uid)
                    # Telegram rate limit
                    await asyncio.sleep(0.1)
                except Exception as e:
                    logger.warning(f"[miss_you_job] send fail {uid}: {e}")

        except asyncio.CancelledError:
            logger.info("[miss_you_job] cancelled, exiting.")
            raise
        except Exception as e:
            logger.error(f"[miss_you_job] error: {e}", exc_info=True)
            # Hata olursa 30 dakika sonra tekrar dene
            await asyncio.sleep(1800)


# ============================================================
# STARTUP / SHUTDOWN
# ============================================================
async def on_startup():
    me = await bot.get_me()
    logger.info(f"Bot started: @{me.username} ({me.id})")

    # Background job başlat
    asyncio.create_task(miss_you_job())
    logger.info("Background jobs started (miss_you_job).")


async def on_shutdown():
    logger.info("Bot shutting down...")
    await bot.session.close()


def main():
    dp.startup.register(on_startup)
    dp.shutdown.register(on_shutdown)
    logger.info("Starting polling...")
    dp.run_polling(bot, allowed_updates=dp.resolve_used_update_types())


if __name__ == "__main__":
    main()
