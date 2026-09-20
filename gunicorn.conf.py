# Gunicorn auto-loads this file from the working directory,
# no matter what start command the platform uses.
import os

bind = ":" + os.environ.get("PORT", "8080")
workers = 1            # app.py starts a background wake_loop thread; >1 would double-run it
worker_class = "gthread"
threads = 16           # concurrency comes from threads, not processes
timeout = 180
graceful_timeout = 30
keepalive = 15
