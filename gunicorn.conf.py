# Gunicorn auto-loads this file from the working directory,
# no matter what start command the platform uses.
import os

bind = ":" + os.environ.get("PORT", "8080")
workers = 1            # app.py starts a background wake_loop thread; >1 would double-run it
worker_class = "gthread"
threads = 8            # 跑 Claude Code 时它还会回头调本机的 lin 工具（朋友圈、碎碎念…），线程太少会互相卡死；线程本身不占多少内存，吃内存的是 claude 进程（由 CC_MAX_CONCURRENT 限）。11.08 从 4 加到 8：电话改成一句一句念之后，一通电话同时占着 chat-v2 那条流 + 两条 TTS + 转文字，4 条刚好卡死
timeout = 180
graceful_timeout = 30
keepalive = 15
sendfile = False       # /data 是云盘挂载，sendfile 可能只发出半截文件（图片下半截变灰）


# 11.08：命令行里写死的 --threads 2 优先级高于这个文件，容器是 04:05 用旧镜像起的，
# 改 Dockerfile/Procfile 要重建镜像才生效 —— 而重建得在 VPS 宿主上做，我在容器里够不着。
# 所以从钩子里硬掰：on_starting / on_reload 在命令行解析完之后执行，
# 这时候把 cfg 里的 threads 顶上去，master fork 出来的 worker 就是这个数。
# 这样 kill -HUP 1 就能真正变成 8 条，不用等重建。
def _force_threads(server):
    try:
        want = int(os.environ.get("FORCE_THREADS", "8"))
        if int(getattr(server.cfg, "threads", 1) or 1) < want:
            server.cfg.set("threads", want)
            server.log.info("threads forced to %s (command line said %s)", want, server.cfg.threads)
    except Exception:
        pass


def on_starting(server):
    _force_threads(server)


def on_reload(server):
    _force_threads(server)


def post_fork(server, worker):
    # 这一个才是真正管用的：它在子进程里、worker.init_process() 之前跑，
    # 而线程池正是 init_process 按 cfg.threads 建的。on_reload 比 manage_workers 晚一拍，
    # 单靠它永远差一代 worker。
    try:
        want = int(os.environ.get("FORCE_THREADS", "8"))
        if int(getattr(worker.cfg, "threads", 1) or 1) < want:
            worker.cfg.set("threads", want)
    except Exception:
        pass
