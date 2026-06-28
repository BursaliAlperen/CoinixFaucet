"""
Coinix Telegram Bot (aiogram + Firebase)
=========================================
Telegram tarafı. Express backend ile aynı Firebase veritabanını kullanır.

Sorumlulukları:
- /start komutu: Hoşgeldin mesajı + WebApp "Open App" butonu + deep link referral
- /promo komutu: Aktif promosyonları listeleme + admin için /createpromo
- Referral sistemi: /start ref_<userId> ile davet, kullanıcı bot_users koleksiyonuna kayıt
- Admin: /createpromo (CNX/DOGE, ödül, limit, expiry), /broadcast, /stats
- startapp parametresi: Mini App'in açılışında referral veya promo query'si parse
- "We missed you" inaktif kullanıcı mesajı (background job)
- Tüm kullanıcı etkileşimleri Firestore'a yazılır (bot_users, logs, promos)

ENV:
    BOT_TOKEN=123456:ABC...
    BOT_USERNAME=CoinixBot
    APP_URL=https://coinix-faucet.vercel.app
    ADMIN_TELEGRAM_ID=123456789
    FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
    # veya FIREBASE_SERVICE_ACCOUNT_BASE64=... / FIREBASE_SERVICE_ACCOUNT_PATH=serviceAccountKey.json
"""

import asyncio
import json
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
        ReplyKeyboardMarkup,
        KeyboardButton,
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

INACTIVE_THRESHOLD_DAYS = 3
INACTIVE_CHECK_INTERVAL_HOURS = 6
INACTIVE_DAILY_BATCH = 200

REFERRAL_SIGNUP_BONUS = 50  # CNX - matches backend
PROMO_DEFAULT_REWARD = 5
PROMO_DEFAULT_LIMIT = 100
PROMO_DEFAULT_EXPIRY_DAYS = 30

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
            sa_info = json.loads(_firebase_service_account_json)
            cred = credentials.Certificate(sa_info)
            firebase_admin.initialize_app(cred)
            logger.info("Firebase initialized from FIREBASE_SERVICE_ACCOUNT_JSON")
        elif _firebase_service_account_base64:
            import base64
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
# LOCAL FALLBACK (Firebase yoksa minimal RAM store)
# ============================================================
_LOCAL_USERS: dict[int, dict] = {}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def _is_admin(uid: int) -> bool:
    return str(uid) == str(ADMIN_TELEGRAM_ID)


def _normalize_code(code: str) -> str:
    return (code or "").strip().upper()


def validate_promo_code(code: str) -> Optional[str]:
    norm = _normalize_code(code)
    if len(norm) < 3 or len(norm) > 32:
        return None
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
    if not all(ch in allowed for ch in norm):
        return None
    return norm


async def upsert_user(telegram_user: types.User, referrer_id: Optional[int] = None) -> bool:
    """Kullanıcıyı Firestore'a kaydet (yeni ise True)."""
    uid = telegram_user.id
    now = _now_utc()
    is_new = False
    payload = {
        "user_id": uid,
        "username": telegram_user.username or "",
        "first_name": telegram_user.first_name or "",
        "last_name": telegram_user.last_name or "",
        "language_code": telegram_user.language_code or "en",
        "is_bot": telegram_user.is_bot,
        "last_seen": now,
        "last_seen_iso": _iso(now),
        "updated_at": now,
    }

    if firestore_available and db:
        try:
            user_ref = db.collection("bot_users").document(str(uid))
            snap = user_ref.get()
            is_new = not snap.exists
            existing = snap.to_dict() if snap.exists else {}
            data = {
                **payload,
                "created_at": existing.get("created_at", now) if snap.exists else now,
                "joined_via": existing.get("joined_via", "telegram_bot") if snap.exists else "telegram_bot",
                "referrer_id": existing.get("referrer_id", referrer_id) if snap.exists else referrer_id,
                "is_admin": _is_admin(uid),
                "start_count": firestore.Increment(1),
                "last_miss_you_sent": existing.get("last_miss_you_sent"),
                "miss_you_sent_count": firestore.Increment(0),  # placeholder
            }
            # Simpler update: just merge with explicit values
            user_ref.set(data, merge=True)
            return is_new
        except Exception as e:
            logger.error(f"Firebase upsert_user error: {e}")

    # Local fallback
    is_new = uid not in _LOCAL_USERS
    if is_new:
        _LOCAL_USERS[uid] = {
            **payload,
            "created_at": now,
            "joined_via": "telegram_bot",
            "referrer_id": referrer_id,
            "is_admin": _is_admin(uid),
            "start_count": 1,
            "miss_you_sent_count": 0,
        }
    else:
        _LOCAL_USERS[uid].update(payload)
        _LOCAL_USERS[uid]["start_count"] = _LOCAL_USERS[uid].get("start_count", 0) + 1
    return is_new


async def mark_active(telegram_id: int) -> None:
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


async def mark_miss_you_sent(telegram_id: int) -> None:
    now = _now_utc()
    if firestore_available and db:
        try:
            db.collection("bot_users").document(str(telegram_id)).set({
                "last_miss_you_sent": now,
                "updated_at": now,
            }, merge=True)
            # Increment separately
            db.collection("bot_users").document(str(telegram_id)).update({
                "miss_you_sent_count": firestore.Increment(1)
            })
            return
        except Exception as e:
            logger.error(f"Firebase mark_miss_you error: {e}")
    if telegram_id in _LOCAL_USERS:
        _LOCAL_USERS[telegram_id]["last_miss_you_sent"] = now
        _LOCAL_USERS[telegram_id]["miss_you_sent_count"] = _LOCAL_USERS[telegram_id].get("miss_you_sent_count", 0) + 1


async def fetch_inactive_users(days_threshold: int, limit: int) -> list:
    if not firestore_available or not db:
        return []
    cutoff = _now_utc() - timedelta(days=days_threshold)
    results = []
    try:
        users_ref = db.collection("bot_users")
        query = users_ref.where("last_seen", "<", cutoff).limit(limit)
        for doc in query.stream():
            data = doc.to_dict() or {}
            data["_id"] = doc.id
            if not data.get("last_miss_you_sent"):
                results.append(data)
        return results
    except Exception as e:
        logger.error(f"fetch_inactive_users error: {e}")
        return []


async def log_event(action: str, user_id: Optional[int], details: dict = None) -> None:
    """Bot tarafından üretilen olayları logs koleksiyonuna yaz."""
    if not firestore_available or not db:
        return
    try:
        db.collection("logs").add({
            "action": action,
            "user_id": str(user_id) if user_id else None,
            "details": details or {},
            "source": "telegram_bot",
            "timestamp": firestore.SERVER_TIMESTAMP,
        })
    except Exception as e:
        logger.error(f"log_event error: {e}")


# ============================================================
# KEYBOARDS
# ============================================================
def main_menu_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🚀 Open App", web_app=WebAppInfo(url=APP_URL))],
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
    "/promo – How to use promo codes (and list active ones)\n"
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
# PROMO HELPERS (used by /promo list + /createpromo admin)
# ============================================================
async def list_active_promos(limit: int = 10) -> list:
    """Aktif ve süresi dolmamış promosyonları getir (admin tarafından oluşturulanlar)."""
    if not firestore_available or not db:
        return []
    try:
        snap = db.collection("promoCodes").where("enabled", "==", True).limit(limit * 2).stream()
        items = []
        now = datetime.now(timezone.utc)
        for doc in snap:
            data = doc.to_dict() or {}
            exp = data.get("expiresAt")
            if exp:
                if hasattr(exp, "to_datetime"):
                    exp_dt = exp.to_datetime()
                elif isinstance(exp, datetime):
                    exp_dt = exp if exp.tzinfo else exp.replace(tzinfo=timezone.utc)
                else:
                    exp_dt = None
                if exp_dt and exp_dt < now:
                    continue
            used = data.get("usedCount", 0) or 0
            limit_v = data.get("usageLimit", data.get("maxUses", 0)) or 0
            if limit_v > 0 and used >= limit_v:
                continue
            items.append({
                "code": doc.id,
                "coin": data.get("coin", "CNX"),
                "reward": data.get("reward", 0),
                "limit": limit_v,
                "used": used,
            })
            if len(items) >= limit:
                break
        return items
    except Exception as e:
        logger.error(f"list_active_promos error: {e}")
        return []


def format_promo_list(promos: list) -> str:
    if not promos:
        return (
            "🎁 <b>Active Promo Codes</b>\n\n"
            "😔 No active promo codes right now. Stay tuned — we drop new ones regularly.\n"
            "Join <a href=\"https://t.me/CoinixCommunity\">@CoinixCommunity</a> to be the first to know!"
        )
    lines = ["🎁 <b>Active Promo Codes</b>\n"]
    for p in promos:
        coin_icon = "🪙" if p["coin"] == "CNX" else "🐶"
        remain = (p["limit"] - p["used"]) if p["limit"] else "∞"
        lines.append(
            f"🎫 <code>{p['code']}</code> — <b>+{p['reward']} {p['coin']}</b> "
            f"{coin_icon}\n   <i>Remaining: {remain}</i>"
        )
    lines.append("\n📲 Open the app and go to <b>Promo Codes</b> to redeem!")
    return "\n\n".join(lines)


async def create_promo_in_firestore(code: str, coin: str, reward: float, usage_limit: int, expires_at: Optional[datetime]) -> tuple[bool, str]:
    if not firestore_available or not db:
        return False, "❌ Firebase unavailable, can't create promo."
    norm = validate_promo_code(code)
    if not norm:
        return False, "❌ Invalid code. Use 3-32 chars, A-Z 0-9 _ -"
    if coin not in ("CNX", "DOGE"):
        return False, "❌ Coin must be CNX or DOGE."
    if reward <= 0:
        return False, "❌ Reward must be > 0."
    try:
        ref = db.collection("promoCodes").document(norm)
        if ref.get().exists:
            return False, f"❌ Code <code>{norm}</code> already exists."
        ref.set({
            "code": norm,
            "coin": coin,
            "reward": float(reward),
            "usageLimit": int(usage_limit) if usage_limit > 0 else PROMO_DEFAULT_LIMIT,
            "usedCount": 0,
            "usedBy": [],
            "enabled": True,
            "createdBy": str(ADMIN_TELEGRAM_ID),
            "createdAt": firestore.SERVER_TIMESTAMP,
            "expiresAt": expires_at,
            "source": "telegram_bot",
        })
        await log_event("promo_create_bot", None, {
            "code": norm, "coin": coin, "reward": reward, "usageLimit": usage_limit
        })
        return True, norm
    except Exception as e:
        logger.error(f"create_promo error: {e}")
        return False, f"❌ Failed: {e}"


# ============================================================
# FSM (admin promo creation wizard)
# ============================================================
class CreatePromoFSM(StatesGroup):
    waiting_code = State()
    waiting_coin = State()
    waiting_reward = State()
    waiting_limit = State()
    waiting_expiry = State()


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

    # Parse referral / promo params from /start <arg>
    # Supports: ref_<userId>, promo_<CODE>, app
    referrer_id: Optional[int] = None
    promo_code: Optional[str] = None
    args_raw = command.args or ""

    if args_raw:
        if args_raw.startswith("ref_"):
            try:
                referrer_id = int(args_raw.replace("ref_", "").strip())
                if referrer_id == user.id:
                    referrer_id = None
            except ValueError:
                referrer_id = None
        elif args_raw.startswith("promo_"):
            promo_code = validate_promo_code(args_raw.replace("promo_", "", 1))

    is_new = await upsert_user(user, referrer_id=referrer_id)

    text = (WELCOME_NEW if is_new else WELCOME_BACK)
    if referrer_id:
        text += REFERRAL_BONUS_NOTE
    if promo_code:
        text += f"\n\n🎫 <b>Promo code activated:</b> <code>{promo_code}</code>\nOpen the app to redeem it!"

    await message.answer(text, reply_markup=main_menu_keyboard())

    if firestore_available and db:
        try:
            db.collection("logs").add({
                "action": "bot_start",
                "user_id": user.id,
                "username": user.username or "",
                "is_new": is_new,
                "referrer_id": referrer_id,
                "promo_code": promo_code,
                "source": "telegram_bot",
                "timestamp": firestore.SERVER_TIMESTAMP,
            })
        except Exception as e:
            logger.error(f"start log error: {e}")


@dp.message(Command("app"))
async def cmd_app(message: types.Message):
    await mark_active(message.from_user.id)
    await message.answer(
        "🚀 <b>Launching Coinix App...</b>",
        reply_markup=goto_app_keyboard(),
    )


@dp.message(Command("balance"))
async def cmd_balance(message: types.Message):
    await mark_active(message.from_user.id)
    await message.answer(
        "💰 <b>Your Balance</b>\n\n"
        "Open the app to see your live DOGE & CNX balance, today's earnings, "
        "and pending withdrawals.",
        reply_markup=goto_app_keyboard(),
    )


@dp.message(Command("promo"))
async def cmd_promo(message: types.Message):
    """/promo — Aktif promosyonları listele."""
    await mark_active(message.from_user.id)
    promos = await list_active_promos(limit=15)
    text = format_promo_list(promos)
    await message.answer(text, reply_markup=goto_app_keyboard())
    await log_event("promo_list_view", message.from_user.id, {"count": len(promos)})


@dp.message(Command("createpromo"))
async def cmd_createpromo(message: types.Message, command: CommandObject, state: FSMContext):
    """Admin tek satırda promo oluşturabilir: /createpromo CODE COIN REWARD [LIMIT] [DAYS]"""
    user = message.from_user
    if not user or not _is_admin(user.id):
        return

    await mark_active(user.id)

    # Quick inline parse
    raw = (message.text or "").replace("/createpromo", "", 1).strip()
    if raw:
        parts = raw.split()
        if len(parts) >= 3:
            code = parts[0]
            coin = parts[1].upper()
            try:
                reward = float(parts[2])
            except ValueError:
                await message.answer("❌ Reward must be a number.")
                return
            try:
                limit = int(parts[3]) if len(parts) >= 4 else PROMO_DEFAULT_LIMIT
            except ValueError:
                limit = PROMO_DEFAULT_LIMIT
            try:
                days = int(parts[4]) if len(parts) >= 5 else PROMO_DEFAULT_EXPIRY_DAYS
            except ValueError:
                days = PROMO_DEFAULT_EXPIRY_DAYS
            expiry = datetime.now(timezone.utc) + timedelta(days=days) if days > 0 else None
            ok, result = await create_promo_in_firestore(code, coin, reward, limit, expiry)
            if ok:
                await message.answer(
                    f"✅ <b>Promo code created!</b>\n\n"
                    f"🎫 <code>{result}</code>\n"
                    f"🪙 Reward: <b>{reward} {coin}</b>\n"
                    f"👥 Usage limit: <b>{limit}</b>\n"
                    f"⏰ Expires in: <b>{days} days</b>",
                    reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                        [InlineKeyboardButton(text="🚀 Open App", web_app=WebAppInfo(url=APP_URL))]
                    ]),
                )
            else:
                await message.answer(result)
            return

        await message.answer(
            "📌 <b>Quick usage:</b>\n"
            "<code>/createpromo CODE COIN REWARD [LIMIT] [DAYS]</code>\n\n"
            "<b>Example:</b>\n"
            "<code>/createpromo WELCOME100 CNX 100 500 30</code>\n\n"
            "Or start the interactive wizard:",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="🧙 Interactive wizard", callback_data="createpromo_wizard")]
            ]),
        )
        return

    # No args: launch wizard
    await state.set_state(CreatePromoFSM.waiting_code)
    await message.answer(
        "🧙 <b>Create Promo Code</b>\n\n"
        "📌 <b>Step 1/5:</b> Enter the promo code (3-32 chars, A-Z 0-9 _ -)\n\n"
        "Type <code>cancel</code> to abort.",
        reply_markup=back_keyboard(),
    )


@dp.callback_query(F.data == "createpromo_wizard")
async def cb_createpromo_wizard(call: types.CallbackQuery, state: FSMContext):
    if not _is_admin(call.from_user.id):
        await call.answer("Admins only.", show_alert=True)
        return
    await state.set_state(CreatePromoFSM.waiting_code)
    await call.message.edit_text(
        "🧙 <b>Create Promo Code</b>\n\n"
        "📌 <b>Step 1/5:</b> Enter the promo code (3-32 chars, A-Z 0-9 _ -)\n\n"
        "Type <code>cancel</code> to abort.",
    )
    await call.answer()


@dp.message(CreatePromoFSM.waiting_code)
async def fsm_code(message: types.Message, state: FSMContext):
    if not _is_admin(message.from_user.id):
        return
    if (message.text or "").strip().lower() == "cancel":
        await state.clear()
        await message.answer("Cancelled.", reply_markup=back_keyboard())
        return
    code = validate_promo_code(message.text or "")
    if not code:
        await message.answer("❌ Invalid code. Use 3-32 chars: A-Z 0-9 _ -")
        return
    await state.update_data(code=code)
    await state.set_state(CreatePromoFSM.waiting_coin)
    await message.answer(
        f"✅ Code: <code>{code}</code>\n\n"
        "📌 <b>Step 2/5:</b> Choose coin type",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [
                InlineKeyboardButton(text="🪙 CNX", callback_data="coin_CNX"),
                InlineKeyboardButton(text="🐶 DOGE", callback_data="coin_DOGE"),
            ]
        ]),
    )


@dp.callback_query(F.data.startswith("coin_"))
async def cb_coin(call: types.CallbackQuery, state: FSMContext):
    if not _is_admin(call.from_user.id):
        await call.answer("Admins only.", show_alert=True)
        return
    coin = call.data.split("_", 1)[1].upper()
    await state.update_data(coin=coin)
    await state.set_state(CreatePromoFSM.waiting_reward)
    await call.message.edit_text(
        f"✅ Coin: <b>{coin}</b>\n\n"
        "📌 <b>Step 3/5:</b> Enter reward amount (number > 0)",
    )
    await call.answer()


@dp.message(CreatePromoFSM.waiting_reward)
async def fsm_reward(message: types.Message, state: FSMContext):
    if not _is_admin(message.from_user.id):
        return
    try:
        reward = float((message.text or "").strip())
    except ValueError:
        await message.answer("❌ Enter a valid number.")
        return
    if reward <= 0:
        await message.answer("❌ Reward must be > 0.")
        return
    await state.update_data(reward=reward)
    await state.set_state(CreatePromoFSM.waiting_limit)
    await message.answer(
        f"✅ Reward: <b>{reward}</b>\n\n"
        "📌 <b>Step 4/5:</b> Enter usage limit (or 0 for unlimited)",
    )


@dp.message(CreatePromoFSM.waiting_limit)
async def fsm_limit(message: types.Message, state: FSMContext):
    if not _is_admin(message.from_user.id):
        return
    try:
        limit = int((message.text or "0").strip())
    except ValueError:
        await message.answer("❌ Enter a valid integer (or 0).")
        return
    if limit < 0:
        limit = 0
    await state.update_data(limit=limit or PROMO_DEFAULT_LIMIT)
    await state.set_state(CreatePromoFSM.waiting_expiry)
    await message.answer(
        f"✅ Limit: <b>{limit or '∞'}</b>\n\n"
        "📌 <b>Step 5/5:</b> Enter expiry in days (or 0 for no expiry)",
    )


@dp.message(CreatePromoFSM.waiting_expiry)
async def fsm_expiry(message: types.Message, state: FSMContext):
    if not _is_admin(message.from_user.id):
        return
    try:
        days = int((message.text or "0").strip())
    except ValueError:
        await message.answer("❌ Enter a valid integer.")
        return
    if days < 0:
        days = 0

    data = await state.get_data()
    code = data.get("code")
    coin = data.get("coin")
    reward = data.get("reward")
    limit = data.get("limit", PROMO_DEFAULT_LIMIT)
    expiry = datetime.now(timezone.utc) + timedelta(days=days) if days > 0 else None
    ok, result = await create_promo_in_firestore(code, coin, reward, limit, expiry)
    await state.clear()
    if ok:
        await message.answer(
            f"✅ <b>Promo code created!</b>\n\n"
            f"🎫 <code>{result}</code>\n"
            f"🪙 Reward: <b>{reward} {coin}</b>\n"
            f"👥 Usage limit: <b>{limit}</b>\n"
            f"⏰ Expires in: <b>{days or 'never'}</b> days",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="🚀 Open App", web_app=WebAppInfo(url=APP_URL))]
            ]),
        )
    else:
        await message.answer(result, reply_markup=back_keyboard())


@dp.message(Command("deletepromo"))
async def cmd_deletepromo(message: types.Message, command: CommandObject):
    """Admin: /deletepromo CODE"""
    if not _is_admin(message.from_user.id):
        return
    await mark_active(message.from_user.id)
    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2:
        await message.answer("Usage: <code>/deletepromo CODE</code>")
        return
    code = validate_promo_code(parts[1])
    if not code:
        await message.answer("❌ Invalid code format.")
        return
    if not firestore_available or not db:
        await message.answer("❌ Firebase unavailable.")
        return
    try:
        ref = db.collection("promoCodes").document(code)
        if not ref.get().exists:
            await message.answer(f"❌ Code <code>{code}</code> not found.")
            return
        ref.delete()
        await log_event("promo_delete_bot", message.from_user.id, {"code": code})
        await message.answer(f"✅ Code <code>{code}</code> deleted.", reply_markup=back_keyboard())
    except Exception as e:
        logger.error(f"deletepromo error: {e}")
        await message.answer(f"❌ Error: {e}")


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
        f"• Plus <b>{REFERRAL_SIGNUP_BONUS} CNX</b> signup bonus per friend\n"
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
    promos = await list_active_promos(limit=15)
    text = format_promo_list(promos)
    await call.message.edit_text(text, reply_markup=goto_app_keyboard())
    await call.answer()


@dp.callback_query(F.data == "mystats")
async def cb_mystats(call: types.CallbackQuery):
    await mark_active(call.from_user.id)
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
    await call.message.edit_text(WELCOME_BACK, reply_markup=main_menu_keyboard())
    await call.answer()


# ---------- Admin commands ----------

@dp.message(Command("broadcast"))
async def cmd_broadcast(message: types.Message):
    """Admin tüm kullanıcılara mesaj göndersin."""
    user = message.from_user
    if not user or not _is_admin(user.id):
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
                await asyncio.sleep(0.05)
            except Exception as e:
                failed += 1
                logger.warning(f"broadcast send fail {uid}: {e}")
    except Exception as e:
        logger.error(f"broadcast error: {e}")
        await message.answer(f"❌ Broadcast error: {e}")
        return
    await log_event("broadcast_bot", user.id, {"sent": sent, "failed": failed, "len": len(text)})
    await message.answer(f"✅ Broadcast done.\n📤 Sent: {sent}\n❌ Failed: {failed}")


@dp.message(Command("stats"))
async def cmd_stats(message: types.Message):
    """Admin için kullanıcı sayısı."""
    user = message.from_user
    if not user or not _is_admin(user.id):
        return
    await mark_active(user.id)
    if not firestore_available or not db:
        count = len(_LOCAL_USERS)
        await message.answer(f"📊 Local users (RAM only): <b>{count}</b>")
        return
    try:
        users_count = len(list(db.collection("bot_users").stream()))
        # Active promo codes
        promo_count = 0
        try:
            for d in db.collection("promoCodes").where("enabled", "==", True).stream():
                promo_count += 1
        except Exception:
            pass
        await message.answer(
            f"📊 <b>Bot Stats</b>\n\n"
            f"👥 Total bot users: <b>{users_count}</b>\n"
            f"🎫 Active promo codes: <b>{promo_count}</b>\n"
            f"🤖 Firebase: <b>connected</b>",
            reply_markup=back_keyboard(),
        )
    except Exception as e:
        await message.answer(f"❌ Stats error: {e}")


# ---------- Catch-all ----------

@dp.message()
async def fallback(message: types.Message):
    user = message.from_user
    if not user or user.is_bot:
        return
    await mark_active(user.id)
    # If state is active, ignore fallback (FSM expects reply)
    current_state = await dp.fsm.get_state(user.id, user.id)
    if current_state is not None:
        return
    await message.answer(
        "👋 <b>Hey there!</b>\n\n"
        "Use the menu below or type /help to see what I can do.",
        reply_markup=main_menu_keyboard(),
    )


# ============================================================
# BACKGROUND JOB: INACTIVE USERS
# ============================================================
async def miss_you_job():
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
                    await bot.send_message(uid, msg, reply_markup=goto_app_keyboard())
                    await mark_miss_you_sent(uid)
                    await asyncio.sleep(0.1)
                except Exception as e:
                    logger.warning(f"[miss_you_job] send fail {uid}: {e}")
        except asyncio.CancelledError:
            logger.info("[miss_you_job] cancelled, exiting.")
            raise
        except Exception as e:
            logger.error(f"[miss_you_job] error: {e}", exc_info=True)
            await asyncio.sleep(1800)


# ============================================================
# STARTUP / SHUTDOWN
# ============================================================
async def on_startup():
    me = await bot.get_me()
    logger.info(f"Bot started: @{me.username} ({me.id})")
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