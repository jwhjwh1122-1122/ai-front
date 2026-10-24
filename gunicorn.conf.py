# Gunicorn auto-loads this file from the working directory,
# no matter what start command the platform uses.
import os

bind = ":" + os.environ.get("PORT", "8080")
workers = 1            # app.py starts a background wake_loop thread; >1 would double-run it
worker_class = "gthread"
threads = 4            # 跑 Claude Code 时它还会回头调本机的 lin 工具（朋友圈、碎碎念…），线程太少会互相卡死；线程本身不占多少内存，吃内存的是 claude 进程（由 CC_MAX_CONCURRENT 限）
timeout = 180
graceful_timeout = 30
keepalive = 15
sendfile = False       # /data 是云盘挂载，sendfile 可能只发出半截文件（图片下半截变灰）
