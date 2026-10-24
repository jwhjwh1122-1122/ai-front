# Gunicorn auto-loads this file from the working directory,
# no matter what start command the platform uses.
import os

bind = ":" + os.environ.get("PORT", "8080")
workers = 1            # app.py starts a background wake_loop thread; >1 would double-run it
worker_class = "gthread"
threads = 2            # 2GB 内存：一个线程跑 Claude Code，另一个应付其余接口；并发靠 cc_mode 的排队限制
timeout = 180
graceful_timeout = 30
keepalive = 15
