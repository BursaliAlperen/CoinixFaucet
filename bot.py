"""
Coinix Telegram Bot (Aiogram 3.x + Firebase Firestore)
====================================================

Production-ready Telegram bot for COINIX Faucet platform.

Features:
- Aiogram 3.x Router-based architecture
- Firebase Firestore integration with retry mechanism
- FSM for interactive admin wizards
- Throttling middleware (Flood Protection)
- Error handling middleware
- Graceful shutdown
- Referral system with deep links
- Promo code management
- Broadcast system
- Inactive user re-engagement (miss_you job)
- Admin commands with proper authorization

ENV Variables:
- BOT_TOKEN: Telegram bot token (required)
- BOT_USERNAME: Bot username without @
- APP_URL: Mini App URL
- ADMIN_TELEGRAM_ID: Telegram user ID of admin
- FIREBASE_SERVICE_ACCOUNT_JSON: JSON string of service account
- FIREBASE_SERVICE_ACCOUNT_BASE64: Base64 encoded service account
- FIREBASE_SERVICE_ACCOUNT_PATH: Path to serviceAccountKey.json

Author: COINIX Team
Version: 2.0.0
"""

import asyncio
import base64
import json
import logging
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

# ============================================
# DEPENDENCY CHECKS
# ============================================

try:
    from aiogram import Bot, Dispatcher, F, Router, types
    from aiogram.client.default import DefaultBotProperties
    from aiogram.enums import ParseMode, ChatAction
    from aiogram.filters import Command, CommandObject, CommandStart, StateFilter
    from aiogram.fsm.context import FSMContext
    from aiogram.fsm.state import State, StatesGroup
    from aiogram.fsm.storage.memory import MemoryStorage
    from aiogram.types import (
        BotCommand,
        BotCommandScopeDefault,
        CallbackQuery,
        InlineKeyboardButton,
        InlineKeyboardMarkup,
        Message,
        WebAppInfo,
    )
    from aiogram.utils.keyboard import InlineKeyboardBuilder
except ImportError:
    print("aiogram is not installed. Install with: pip install 'aiogram>=3.4'", file=sys.stderr)
    raise

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
    from google.cloud.firestore_v1.base_document import DocumentSnapshot
except ImportError:
    print("firebase-admin is not installed. Install with: pip install firebase-admin", file=sys.stderr)
    raise

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ============================================
# CONFIGURATION
# ============================================

BOT_TOKEN: Optional[str] = os.getenv("BOT_TOKEN")
BOT_USERNAME: str = os.getenv("BOT_USERNAME", "CoinixBot")
APP_URL: str = os.getenv("APP_URL", "https://coinix-faucet.vercel.app")
ADMIN_TELEGRAM_ID: str = os.getenv("ADMIN_TELEGRAM_ID", "")

INACTIVE_THRESHOLD_DAYS: int = 3
INACTIVE_CHECK_INTERVAL_HOURS: int = 6
INACTIVE_DAILY_BATCH: int = 200

REFERRAL_SIGNUP_BONUS: int = 50  # CNX - matches backend

PROMO_DEFAULT_REWARD: int = 5
PROMO_DEFAULT_LIMIT: int = 100
PROMO_DEFAULT_EXPIRY_DAYS: int = 30

FIRESTORE_RETRY_MAX: int = 3
FIRESTORE_RETRY_BASE_DELAY: float = 1.0

# ============================================
# VALIDATION
# ============================================

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN environment variable is required")

# ============================================
# LOGGING SETUP
# ============================================

class JsonFormatter(logging.Formatter):
    """JSON log formatter for structured logging in production."""
    
    def format(self, record: logging.LogRecord) -> str:
        log_data = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info and record.exc_info[0] is not None:
            log_data["exception"] = self.formatException(record.exc_info)
        if hasattr(record, "extra_data"):
            log_data["extra"] = record.extra_data
        return json.dumps(log_data, ensure_ascii=False)


def setup_logging() -> logging.Logger:
    """Configure production-ready logging."""
    logger = logging.getLogger("coinix-bot")
    logger.setLevel(logging.INFO)
    
    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    
    # Use JSON formatter in production, plain in development
    if os.getenv("NODE_ENV") == "production":
        formatter = JsonFormatter()
    else:
        formatter = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"
        )
    
    console_handler.setFormatter(formatter)
    
    # Avoid duplicate handlers
    if not logger.handlers:
        logger.addHandler(console_handler)
    
    return logger


logger: logging.Logger = setup_logging()

# ============================================
# FIREBASE INITIALIZATION
# ============================================

db: Optional[firestore.Client] = None
firestore_available: bool = False

_firebase_service_account_json: Optional[str] = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
_firebase_service_account_base64: Optional[str] = os.getenv("FIREBASE_SERVICE_ACCOUNT_BASE64")
_firebase_service_account_path: str = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "serviceAccountKey.json")


async def firestore_with_retry(func, *args, **kwargs) -> Any:
    """Execute Firestore operation with exponential backoff retry."""
    last_error: Optional[Exception] = None
    for attempt in range(1, FIRESTORE_RETRY_MAX + 1):
        try:
            result = func(*args, **kwargs)
            if asyncio.iscoroutine(result):
                return await result
            return result
        except Exception as e:
            last_error = e
            if attempt == FIRESTORE_RETRY_MAX:
                break
            delay = FIRESTORE_RETRY_BASE_DELAY * (2 ** (attempt - 1)) + random.random() * 0.5
            logger.warning(
                f"Firestore retry {attempt}/{FIRESTORE_RETRY_MAX}, waiting {delay:.2f}s",
                extra={"extra_data": {"error": str(e)}}
            )
            await asyncio.sleep(delay)
    raise last_error


def initialize_firebase() -> None:
    """Initialize Firebase Admin SDK with multiple credential sources."""
    global db, firestore_available
    
    try:
        if firebase_admin._apps:
            logger.info("Firebase already initialized")
            db = firestore.client()
            firestore_available = True
            return
        
        service_account_info: Optional[Dict[str, Any]] = None
        
        if _firebase_service_account_json:
            service_account_info = json.loads(_firebase_service_account_json)
            logger.info("Firebase: Using FIREBASE_SERVICE_ACCOUNT_JSON env var")
        elif _firebase_service_account_base64:
            decoded = base64.b64decode(_firebase_service_account_base64).decode("utf-8")
            service_account_info = json.loads(decoded)
            logger.info("Firebase: Using FIREBASE_SERVICE_ACCOUNT_BASE64 env var")
        elif os.path.exists(_firebase_service_account_path):
            with open(_firebase_service_account_path, "r", encoding="utf-8") as f:
                service_account_info = json.load(f)
            logger.info(f"Firebase: Using {_firebase_service_account_path}")
        else:
            logger.warning("Firebase credentials not found, bot will run without DB")
            return
        
        cred = credentials.Certificate(service_account_info)
        firebase_admin.initialize_app(cred)
        db = firestore.client()
        firestore_available = True
        logger.info("Firebase initialized successfully")
        
    except Exception as e:
        logger.error(f"Firebase init failed: {e}", exc_info=True)
        firestore_available = False


initialize_firebase()

# ============================================
# BOT & DISPATCHER INITIALIZATION
# ============================================

bot: Bot = Bot(
    token=BOT_TOKEN,
    default=DefaultBotProperties(parse_mode=ParseMode.HTML)
)

storage = MemoryStorage()
dp = Dispatcher(storage=storage)

# Main router for handlers
router = Router(name="main")
admin_router = Router(name="admin")
fsm_router = Router(name="fsm")

# ============================================
# UTILITY FUNCTIONS
# ============================================

def now_utc() -> datetime:
    """Get current UTC datetime."""
    return datetime.now(timezone.utc)


def iso_format(dt: datetime) -> str:
    """Format datetime as ISO 8601 string."""
    return dt.replace(microsecond=0).isoformat()


def is_admin(uid: int) -> bool:
    """Check if user is admin by Telegram ID."""
    return str(uid) == str(ADMIN_TELEGRAM_ID) and ADMIN_TELEGRAM_ID != ""


def validate_promo_code(code: str) -> Optional[str]:
    """Validate and normalize promo code format."""
    if not code:
        return None
    norm = code.strip().upper()
    if len(norm) < 3 or len(norm) > 32:
        return None
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    if not all(ch in allowed for ch in norm):
        return None
    return norm


# ============================================
# MIDDLEWARES
# ============================================

class ThrottlingMiddleware:
    """Flood protection middleware using simple in-memory throttling."""
    
    def __init__(self, rate_limit: float = 1.0):
        self.rate_limit = rate_limit
        self._last_call: Dict[int, float] = {}
    
    async def __call__(
        self,
        handler: Any,
        event: types.Update,
        data: Dict[str, Any]
    ) -> Any:
        user = None
        if hasattr(event, "from_user"):
            user = event.from_user
        elif hasattr(event, "message") and event.message:
            user = event.message.from_user
        elif hasattr(event, "callback_query") and event.callback_query:
            user = event.callback_query.from_user
        
        if not user:
            return await handler(event, data)
        
        uid = user.id
        current_time = asyncio.get_event_loop().time()
        last_time = self._last_call.get(uid, 0)
        
        if current_time - last_time < self.rate_limit:
            # Throttle - don't process
            if hasattr(event, "answer"):
                try:
                    await event.answer("⏱ Too fast! Please slow down.", show_alert=True)
                except Exception:
                    pass
            return None
        
        self._last_call[uid] = current_time
        
        # Cleanup old entries periodically to prevent memory leak
        if len(self._last_call) > 10000:
            cutoff = current_time - 60
            self._last_call = {
                k: v for k, v in self._last_call.items()
                if v > cutoff
            }
        
        return await handler(event, data)


class LoggingMiddleware:
    """Log all incoming events for debugging."""
    
    async def __call__(
        self,
        handler: Any,
        event: types.Update,
        data: Dict[str, Any]
    ) -> Any:
        try:
            if hasattr(event, "message") and event.message:
                msg = event.message
                logger.info(
                    f"Message from {msg.from_user.id if msg.from_user else 'unknown'}",
                    extra={"extra_data": {
                        "type": "message",
                        "text": msg.text[:100] if msg.text else None,
                        "chat_id": msg.chat.id
                    }}
                )
            elif hasattr(event, "callback_query") and event.callback_query:
                cb = event.callback_query
                logger.info(
                    f"Callback from {cb.from_user.id}",
                    extra={"extra_data": {
                        "type": "callback",
                        "data": cb.data
                    }}
                )
        except Exception as e:
            logger.error(f"Logging middleware error: {e}")
        
        return await handler(event, data)


# Apply middlewares
throttling_middleware = ThrottlingMiddleware(rate_limit=0.5)
dp.message.outer_middleware(throttling_middleware)
dp.callback_query.outer_middleware(throttling_middleware)

# ============================================
# FIRESTORE OPERATIONS
# ============================================

async def upsert_user(
    telegram_user: types.User,
    referrer_id: Optional[int] = None
) -> bool:
    """
    Upsert user into Firestore (or local fallback).
    
    Args:
        telegram_user: Telegram user object
        referrer_id: Optional referrer's Telegram ID
    
    Returns:
        True if user is new, False if existing
    """
    uid = telegram_user.id
    now = now_utc()
    is_new = False
    
    payload = {
        "user_id": uid,
        "username": telegram_user.username or "",
        "first_name": telegram_user.first_name or "",
        "last_name": telegram_user.last_name or "",
        "language_code": telegram_user.language_code or "en",
        "is_bot": telegram_user.is_bot,
        "last_seen": now,
        "last_seen_iso": iso_format(now),
        "updated_at": now,
    }
    
    if firestore_available and db:
        try:
            user_ref = db.collection("bot_users").document(str(uid))
            
            def _do_upsert():
                nonlocal is_new
                snap = user_ref.get()
                is_new = not snap.exists
                existing = snap.to_dict() if snap.exists else {}
                
                data = {
                    **payload,
                    "created_at": existing.get("created_at", now) if snap.exists else now,
                    "joined_via": existing.get("joined_via", "telegram_bot") if snap.exists else "telegram_bot",
                    "referrer_id": existing.get("referrer_id", referrer_id) if snap.exists else referrer_id,
                    "is_admin": is_admin(uid),
                    "start_count": firestore.Increment(1),
                    "last_miss_you_sent": existing.get("last_miss_you_sent"),
                    "miss_you_sent_count": firestore.Increment(0),
                }
                
                user_ref.set(data, merge=True)
                return is_new
            
            await firestore_with_retry(_do_upsert)
            return is_new
            
        except Exception as e:
            logger.error(f"Firebase upsert_user error: {e}", exc_info=True)
    
    # Local fallback (for development only)
    logger.warning("Using local fallback for user upsert (Firebase unavailable)")
    return True


async def mark_active(telegram_id: int) -> None:
    """Mark user as active by updating last_seen timestamp."""
    now = now_utc()
    
    if firestore_available and db:
        try:
            def _do_mark():
                db.collection("bot_users").document(str(telegram_id)).set({
                    "last_seen": now,
                    "last_seen_iso": iso_format(now),
                    "updated_at": now,
                }, merge=True)
            
            await firestore_with_retry(_do_mark)
            return
        except Exception as e:
            logger.error(f"Firebase mark_active error: {e}", exc_info=True)


async def mark_miss_you_sent(telegram_id: int) -> None:
    """Mark that 'miss you' message was sent to user."""
    now = now_utc()
    
    if firestore_available and db:
        try:
            def _do_mark():
                doc_ref = db.collection("bot_users").document(str(telegram_id))
                doc_ref.set({
                    "last_miss_you_sent": now,
                    "updated_at": now,
                }, merge=True)
                doc_ref.update({
                    "miss_you_sent_count": firestore.Increment(1)
                })
            
            await firestore_with_retry(_do_mark)
            return
        except Exception as e:
            logger.error(f"Firebase mark_miss_you_sent error: {e}", exc_info=True)


async def fetch_inactive_users(
    days_threshold: int,
    limit: int
) -> List[Dict[str, Any]]:
    """Fetch users who haven't been active for specified days."""
    if not firestore_available or not db:
        return []
    
    cutoff = now_utc() - timedelta(days=days_threshold)
    results: List[Dict[str, Any]] = []
    
    try:
        def _do_fetch():
            users_ref = db.collection("bot_users")
            query = users_ref.where("last_seen", "<", cutoff).limit(limit)
            return list(query.stream())
        
        docs = await firestore_with_retry(_do_fetch)
        
        for doc in docs:
            data = doc.to_dict() or {}
            data["_id"] = doc.id
            if not data.get("last_miss_you_sent"):
                results.append(data)
        
        return results
        
    except Exception as e:
        logger.error(f"fetch_inactive_users error: {e}", exc_info=True)
        return []


async def log_event(
    action: str,
    user_id: Optional[int],
    details: Optional[Dict[str, Any]] = None
) -> None:
    """Log bot-generated events to Firestore logs collection."""
    if not firestore_available or not db:
        return
    
    try:
        def _do_log():
            db.collection("logs").add({
                "action": action,
                "user_id": str(user_id) if user_id else None,
                "details": details or {},
                "source": "telegram_bot",
                "timestamp": firestore.SERVER_TIMESTAMP,
            })
        
        await firestore_with_retry(_do_log)
    except Exception as e:
        logger.error(f"log_event error: {e}", exc_info=True)


# ============================================
# PROMO HELPERS
# ============================================

async def list_active_promos(limit: int = 10) -> List[Dict[str, Any]]:
    """List active and non-expired promo codes."""
    if not firestore_available or not db:
        return []
    
    try:
        def _do_list():
            return list(db.collection("promoCodes")
                       .where("enabled", "==", True)
                       .limit(limit * 2)
                       .stream())
        
        docs = await firestore_with_retry(_do_list)
        items: List[Dict[str, Any]] = []
        now = now_utc()
        
        for doc in docs:
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
        logger.error(f"list_active_promos error: {e}", exc_info=True)
        return []


def format_promo_list(promos: List[Dict[str, Any]]) -> str:
    """Format promo list for Telegram message."""
    if not promos:
        return (
            "🎁 <b>Active Promo Codes</b>\n\n"
            "😔 No active promo codes right now. Stay tuned — we drop new ones regularly.\n"
            f"Join <a href=\"https://t.me/CoinixCommunity\">@CoinixCommunity</a> to be the first to know!"
        )
    
    lines = ["🎁 <b>Active Promo Codes</b>\n"]
    for p in promos:
        coin_icon = "🪙" if p["coin"] == "CNX" else "🐶"
        remain = (p["limit"] - p["used"]) if p["limit"] else "∞"
        lines.append(
            f"🎫 <code>{p['code']}</code> — <b>+{p['reward']} {p['coin']}</b> "
            f"{coin_icon}\n    <i>Remaining: {remain}</i>"
        )
    
    lines.append("\n📲 Open the app and go to <b>Promo Codes</b> to redeem!")
    return "\n\n".join(lines)


async def create_promo_in_firestore(
    code: str,
    coin: str,
    reward: float,
    usage_limit: int,
    expires_at: Optional[datetime]
) -> Tuple[bool, str]:
    """Create a new promo code in Firestore."""
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
        def _do_create():
            ref = db.collection("promoCodes").document(norm)
            if ref.get().exists:
                raise ValueError(f"Code <code>{norm}</code> already exists.")
            
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
            return True
        
        await firestore_with_retry(_do_create)
        await log_event("promo_create_bot", None, {
            "code": norm, "coin": coin, "reward": reward, "usageLimit": usage_limit
        })
        return True, norm
        
    except ValueError as ve:
        return False, f"❌ {ve}"
    except Exception as e:
        logger.error(f"create_promo error: {e}", exc_info=True)
        return False, f"❌ Failed: {e}"


# ============================================
# KEYBOARDS
# ============================================

def main_menu_keyboard() -> InlineKeyboardMarkup:
    """Build main menu inline keyboard."""
    builder = InlineKeyboardBuilder()
    builder.button(
        text="🚀 Open App",
        web_app=WebAppInfo(url=APP_URL)
    )
    builder.button(text="ℹ️ About Bot", callback_data="about_bot")
    builder.button(text="👥 Community", url="https://t.me/CoinixCommunity")
    builder.button(text="💎 Earn CNX", callback_data="earn")
    builder.button(text="🎁 Promo Codes", callback_data="promo")
    builder.button(text="📊 My Stats", callback_data="mystats")
    builder.button(text="❓ Help", callback_data="help")
    builder.adjust(1, 2, 2, 2)
    return builder.as_markup()


def back_keyboard() -> InlineKeyboardMarkup:
    """Build back button keyboard."""
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="⬅️ Back to Menu", callback_data="back_main")]
    ])


def goto_app_keyboard() -> InlineKeyboardMarkup:
    """Build 'Go to App' button keyboard."""
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🚀 Go to App", web_app=WebAppInfo(url=APP_URL))]
    ])


# ============================================
# TEXT MESSAGES
# ============================================

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

# ============================================
# FSM STATES
# ============================================

class CreatePromoFSM(StatesGroup):
    """FSM states for interactive promo code creation wizard."""
    waiting_code = State()
    waiting_coin = State()
    waiting_reward = State()
    waiting_limit = State()
    waiting_expiry = State()


# ============================================
# COMMAND HANDLERS
# ============================================

@router.message(CommandStart())
async def cmd_start(message: Message, command: CommandObject, state: FSMContext) -> None:
    """Handle /start command with deep link support for referrals and promos."""
    await state.clear()
    
    user = message.from_user
    if not user:
        return
    
    # Parse referral / promo params from /start <arg>
    referrer_id: Optional[int] = None
    promo_code: Optional[str] = None
    args_raw = command.args or ""
    
    if args_raw:
        if args_raw.startswith("ref_"):
            try:
                referrer_id = int(args_raw.replace("ref_", "", 1).strip())
                if referrer_id == user.id:
                    referrer_id = None
            except ValueError:
                referrer_id = None
        elif args_raw.startswith("promo_"):
            promo_code = validate_promo_code(args_raw.replace("promo_", "", 1))
    
    is_new = await upsert_user(user, referrer_id=referrer_id)
    
    text = WELCOME_NEW if is_new else WELCOME_BACK
    if referrer_id:
        text += REFERRAL_BONUS_NOTE
    if promo_code:
        text += f"\n\n🎫 <b>Promo code activated:</b> <code>{promo_code}</code>\nOpen the app to redeem it!"
    
    await message.answer(text, reply_markup=main_menu_keyboard())
    
    await log_event("bot_start", user.id, {
        "username": user.username or "",
        "is_new": is_new,
        "referrer_id": referrer_id,
        "promo_code": promo_code,
    })


@router.message(Command("app"))
async def cmd_app(message: Message) -> None:
    """Handle /app command - launch mini app."""
    if message.from_user:
        await mark_active(message.from_user.id)
    await message.answer(
        "🚀 <b>Launching Coinix App...</b>",
        reply_markup=goto_app_keyboard(),
    )


@router.message(Command("balance"))
async def cmd_balance(message: Message) -> None:
    """Handle /balance command - show balance info."""
    if message.from_user:
        await mark_active(message.from_user.id)
    await message.answer(
        "💰 <b>Your Balance</b>\n\n"
        "Open the app to see your live DOGE & CNX balance, today's earnings, "
        "and pending withdrawals.",
        reply_markup=goto_app_keyboard(),
    )


@router.message(Command("promo"))
async def cmd_promo(message: Message) -> None:
    """Handle /promo command - list active promo codes."""
    if message.from_user:
        await mark_active(message.from_user.id)
    promos = await list_active_promos(limit=15)
    text = format_promo_list(promos)
    await message.answer(text, reply_markup=goto_app_keyboard())
    if message.from_user:
        await log_event("promo_list_view", message.from_user.id, {"count": len(promos)})


@router.message(Command("createpromo"))
async def cmd_createpromo(
    message: Message,
    command: CommandObject,
    state: FSMContext
) -> None:
    """Admin: Create promo code (quick or interactive wizard)."""
    user = message.from_user
    if not user or not is_admin(user.id):
        await message.answer("❌ Admins only.")
        return
    
    await mark_active(user.id)
    await state.clear()
    
    # Quick inline parse: /createpromo CODE COIN REWARD [LIMIT] [DAYS]
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
            
            expiry = now_utc() + timedelta(days=days) if days > 0 else None
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
    
    # No args or insufficient args: show wizard option
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


@router.message(Command("deletepromo"))
async def cmd_deletepromo(message: Message, command: CommandObject) -> None:
    """Admin: /deletepromo CODE"""
    user = message.from_user
    if not user or not is_admin(user.id):
        await message.answer("❌ Admins only.")
        return
    
    await mark_active(user.id)
    
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
        def _do_delete():
            ref = db.collection("promoCodes").document(code)
            if not ref.get().exists:
                raise ValueError(f"Code <code>{code}</code> not found.")
            ref.delete()
        
        await firestore_with_retry(_do_delete)
        await log_event("promo_delete_bot", user.id, {"code": code})
        await message.answer(f"✅ Code <code>{code}</code> deleted.", reply_markup=back_keyboard())
        
    except ValueError as ve:
        await message.answer(f"❌ {ve}")
    except Exception as e:
        logger.error(f"deletepromo error: {e}", exc_info=True)
        await message.answer(f"❌ Error: {e}")


@router.message(Command("referral"))
async def cmd_referral(message: Message) -> None:
    """Handle /referral command - show referral link."""
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
            [InlineKeyboardButton(
                text="📤 Share Link",
                url=f"https://t.me/share/url?url={link}&text=Join%20Coinix%20and%20earn%20free%20crypto!"
            )],
            [InlineKeyboardButton(text="🚀 Open App", web_app=WebAppInfo(url=APP_URL))],
        ]),
    )


@router.message(Command("help"))
async def cmd_help(message: Message) -> None:
    """Handle /help command."""
    if message.from_user:
        await mark_active(message.from_user.id)
    await message.answer(HELP_TEXT, reply_markup=main_menu_keyboard())


@router.message(Command("about"))
async def cmd_about(message: Message) -> None:
    """Handle /about command."""
    if message.from_user:
        await mark_active(message.from_user.id)
    await message.answer(ABOUT_BOT, reply_markup=back_keyboard())


# ============================================
# ADMIN COMMANDS
# ============================================

@admin_router.message(Command("broadcast"))
async def cmd_broadcast(message: Message) -> None:
    """Admin: Broadcast message to all users."""
    user = message.from_user
    if not user or not is_admin(user.id):
        await message.answer("❌ Admins only.")
        return
    
    text = (message.text or "").replace("/broadcast", "", 1).strip()
    if not text:
        await message.answer(
            "📢 <b>Broadcast usage:</b>\n"
            "<code>/broadcast Your message here</code>"
        )
        return
    
    if not firestore_available or not db:
        await message.answer("❌ Firebase unavailable, can't fetch user list.")
        return
    
    sent = 0
    failed = 0
    
    try:
        def _get_users():
            return list(db.collection("bot_users").stream())
        
        docs = await firestore_with_retry(_get_users)
        
        for doc in docs:
            data = doc.to_dict() or {}
            uid = data.get("user_id")
            if not uid:
                continue
            try:
                await bot.send_message(uid, f"📢 <b>Announcement</b>\n\n{text}")
                sent += 1
                await asyncio.sleep(0.05)  # Rate limiting
            except Exception as e:
                failed += 1
                logger.warning(f"broadcast send fail {uid}: {e}")
        
        await log_event("broadcast_bot", user.id, {"sent": sent, "failed": failed, "len": len(text)})
        await message.answer(f"✅ Broadcast done.\n📤 Sent: {sent}\n❌ Failed: {failed}")
        
    except Exception as e:
        logger.error(f"broadcast error: {e}", exc_info=True)
        await message.answer(f"❌ Broadcast error: {e}")


@admin_router.message(Command("stats"))
async def cmd_stats(message: Message) -> None:
    """Admin: Show bot statistics."""
    user = message.from_user
    if not user or not is_admin(user.id):
        await message.answer("❌ Admins only.")
        return
    
    await mark_active(user.id)
    
    if not firestore_available or not db:
        await message.answer("📊 Firebase unavailable. Stats not available.")
        return
    
    try:
        def _count_users():
            return len(list(db.collection("bot_users").stream()))
        
        users_count = await firestore_with_retry(_count_users)
        
        # Count active promo codes
        promo_count = 0
        try:
            def _count_promos():
                return len(list(db.collection("promoCodes").where("enabled", "==", True).stream()))
            promo_count = await firestore_with_retry(_count_promos)
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
        logger.error(f"stats error: {e}", exc_info=True)
        await message.answer(f"❌ Stats error: {e}")


# ============================================
# CALLBACK HANDLERS
# ============================================

@router.callback_query(F.data == "about_bot")
async def cb_about(call: CallbackQuery) -> None:
    """Handle 'About Bot' callback."""
    if call.from_user:
        await mark_active(call.from_user.id)
    if call.message:
        await call.message.edit_text(ABOUT_BOT, reply_markup=back_keyboard())
    await call.answer()


@router.callback_query(F.data == "help")
async def cb_help(call: CallbackQuery) -> None:
    """Handle 'Help' callback."""
    if call.from_user:
        await mark_active(call.from_user.id)
    if call.message:
        await call.message.edit_text(HELP_TEXT, reply_markup=main_menu_keyboard())
    await call.answer()


@router.callback_query(F.data == "earn")
async def cb_earn(call: CallbackQuery) -> None:
    """Handle 'Earn' callback."""
    if call.from_user:
        await mark_active(call.from_user.id)
    if call.message:
        await call.message.edit_text(
            EARN_TEXT,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="🚀 Open Earn Zone", web_app=WebAppInfo(url=APP_URL))],
                [InlineKeyboardButton(text="⬅️ Back to Menu", callback_data="back_main")],
            ]),
        )
    await call.answer()


@router.callback_query(F.data == "promo")
async def cb_promo(call: CallbackQuery) -> None:
    """Handle 'Promo Codes' callback."""
    if call.from_user:
        await mark_active(call.from_user.id)
    promos = await list_active_promos(limit=15)
    text = format_promo_list(promos)
    if call.message:
        await call.message.edit_text(text, reply_markup=goto_app_keyboard())
    await call.answer()


@router.callback_query(F.data == "mystats")
async def cb_mystats(call: CallbackQuery) -> None:
    """Handle 'My Stats' callback."""
    if call.from_user:
        await mark_active(call.from_user.id)
    if call.message:
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


@router.callback_query(F.data == "back_main")
async def cb_back_main(call: CallbackQuery) -> None:
    """Handle 'Back to Menu' callback."""
    if call.from_user:
        await mark_active(call.from_user.id)
    if call.message:
        await call.message.edit_text(WELCOME_BACK, reply_markup=main_menu_keyboard())
    await call.answer()


@router.callback_query(F.data == "createpromo_wizard")
async def cb_createpromo_wizard(call: CallbackQuery, state: FSMContext) -> None:
    """Start interactive promo creation wizard."""
    if not call.from_user or not is_admin(call.from_user.id):
        await call.answer("Admins only.", show_alert=True)
        return
    
    await state.set_state(CreatePromoFSM.waiting_code)
    if call.message:
        await call.message.edit_text(
            "🧙 <b>Create Promo Code</b>\n\n"
            "📌 <b>Step 1/5:</b> Enter the promo code (3-32 chars, A-Z 0-9 _ -)\n\n"
            "Type <code>cancel</code> to abort.",
            reply_markup=back_keyboard(),
        )
    await call.answer()


# ============================================
# FSM HANDLERS (Promo Creation Wizard)
# ============================================

@fsm_router.message(CreatePromoFSM.waiting_code)
async def fsm_code(message: Message, state: FSMContext) -> None:
    """FSM Step 1: Get promo code."""
    user = message.from_user
    if not user or not is_admin(user.id):
        await state.clear()
        return
    
    if (message.text or "").strip().lower() == "cancel":
        await state.clear()
        await message.answer("❌ Cancelled.", reply_markup=back_keyboard())
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


@fsm_router.callback_query(CreatePromoFSM.waiting_coin, F.data.startswith("coin_"))
async def cb_coin(call: CallbackQuery, state: FSMContext) -> None:
    """FSM Step 2: Select coin type."""
    if not call.from_user or not is_admin(call.from_user.id):
        await call.answer("Admins only.", show_alert=True)
        return
    
    coin = call.data.split("_", 1)[1].upper()
    await state.update_data(coin=coin)
    await state.set_state(CreatePromoFSM.waiting_reward)
    if call.message:
        await call.message.edit_text(
            f"✅ Coin: <b>{coin}</b>\n\n"
            "📌 <b>Step 3/5:</b> Enter reward amount (number > 0)"
        )
    await call.answer()


@fsm_router.message(CreatePromoFSM.waiting_reward)
async def fsm_reward(message: Message, state: FSMContext) -> None:
    """FSM Step 3: Get reward amount."""
    user = message.from_user
    if not user or not is_admin(user.id):
        await state.clear()
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
        "📌 <b>Step 4/5:</b> Enter usage limit (or 0 for unlimited)"
    )


@fsm_router.message(CreatePromoFSM.waiting_limit)
async def fsm_limit(message: Message, state: FSMContext) -> None:
    """FSM Step 4: Get usage limit."""
    user = message.from_user
    if not user or not is_admin(user.id):
        await state.clear()
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
        "📌 <b>Step 5/5:</b> Enter expiry in days (or 0 for no expiry)"
    )


@fsm_router.message(CreatePromoFSM.waiting_expiry)
async def fsm_expiry(message: Message, state: FSMContext) -> None:
    """FSM Step 5: Get expiry days and create promo."""
    user = message.from_user
    if not user or not is_admin(user.id):
        await state.clear()
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
    expiry = now_utc() + timedelta(days=days) if days > 0 else None
    
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


# ============================================
# FALLBACK HANDLER
# ============================================

@router.message()
async def fallback(message: Message, state: FSMContext) -> None:
    """Catch-all handler for unrecognized messages."""
    user = message.from_user
    if not user or user.is_bot:
        return
    
    await mark_active(user.id)
    
    # If FSM state is active, don't interfere
    current_state = await state.get_state()
    if current_state is not None:
        return
    
    await message.answer(
        "👋 <b>Hey there!</b>\n\n"
        "Use the menu below or type /help to see what I can do.",
        reply_markup=main_menu_keyboard(),
    )


# ============================================
# ERROR HANDLER
# ============================================

@router.error()
async def error_handler(event: types.ErrorEvent) -> None:
    """Global error handler for all updates."""
    logger.error(
        f"Unhandled error: {event.exception}",
        exc_info=event.exception,
        extra={"extra_data": {"update_id": event.update.update_id}}
    )
    
    # Try to notify user if possible
    try:
        if event.update.message:
            await event.update.message.answer(
                "❌ An error occurred. Please try again later."
            )
        elif event.update.callback_query:
            await event.update.callback_query.answer(
                "❌ An error occurred. Please try again.",
                show_alert=True
            )
    except Exception:
        pass


# ============================================
# BACKGROUND JOB: INACTIVE USERS (MISS YOU)
# ============================================

async def miss_you_job() -> None:
    """Background job to re-engage inactive users."""
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
                    await asyncio.sleep(0.1)  # Rate limiting
                except Exception as e:
                    logger.warning(f"[miss_you_job] send fail {uid}: {e}")
                    
        except asyncio.CancelledError:
            logger.info("[miss_you_job] cancelled, exiting.")
            raise
        except Exception as e:
            logger.error(f"[miss_you_job] error: {e}", exc_info=True)
            await asyncio.sleep(1800)  # Wait 30 min before retry


# ============================================
# STARTUP / SHUTDOWN
# ============================================

async def on_startup() -> None:
    """Actions to perform on bot startup."""
    me = await bot.get_me()
    logger.info(f"Bot started: @{me.username} ({me.id})")
    
    # Set bot commands menu
    commands = [
        BotCommand(command="start", description="🚀 Open main menu"),
        BotCommand(command="app", description="📱 Launch the mini app"),
        BotCommand(command="balance", description="💰 Check your balance"),
        BotCommand(command="promo", description="🎁 View active promo codes"),
        BotCommand(command="referral", description="👥 Get your referral link"),
        BotCommand(command="help", description="❓ Show help"),
        BotCommand(command="about", description="ℹ️ About Coinix"),
    ]
    
    try:
        await bot.set_my_commands(commands, scope=BotCommandScopeDefault())
        logger.info("Bot commands menu configured")
    except Exception as e:
        logger.warning(f"Failed to set bot commands: {e}")
    
    # Start background jobs
    asyncio.create_task(miss_you_job())
    logger.info("Background jobs started (miss_you_job).")


async def on_shutdown() -> None:
    """Graceful shutdown handler."""
    logger.info("Bot shutting down...")
    try:
        await bot.session.close()
        logger.info("Bot session closed")
    except Exception as e:
        logger.error(f"Error closing bot session: {e}")
    
    # Cancel all tasks
    tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    for task in tasks:
        task.cancel()
    
    await asyncio.gather(*tasks, return_exceptions=True)
    logger.info("All tasks cancelled. Goodbye!")


# ============================================
# MAIN ENTRY POINT
# ============================================

def main() -> None:
    """Main entry point for the bot."""
    # Include routers
    dp.include_router(admin_router)
    dp.include_router(fsm_router)
    dp.include_router(router)
    
    # Register lifecycle hooks
    dp.startup.register(on_startup)
    dp.shutdown.register(on_shutdown)
    
    logger.info("Starting polling...")
    try:
        dp.run_polling(bot, allowed_updates=dp.resolve_used_update_types())
    except KeyboardInterrupt:
        logger.info("Received keyboard interrupt")
    except Exception as e:
        logger.error(f"Polling error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
