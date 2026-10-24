# 凛 · 后端镜像：Python(Flask/gunicorn) + Node + Claude Code CLI
# 注意：Claude Code 的登录凭据绝不写进镜像。
#   - 方式一：设置环境变量 CLAUDE_CODE_OAUTH_TOKEN（用 `claude setup-token` 生成）
#   - 方式二：设置 CLAUDE_CONFIG_DIR=/data/.claude（放在持久卷里），再在服务器终端里运行 `claude` 登录
# 详见《CC模式部署说明.md》
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates git procps tzdata \
 && rm -rf /var/lib/apt/lists/*

# Claude Code 无头模式（claude -p）
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force \
 && claude --version

WORKDIR /app

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai \
    PORT=8080

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080
# 与 zbpack.json / Procfile 的启动命令一致
CMD ["sh", "-c", "exec gunicorn -w 1 -k gthread --threads 2 --timeout 180 --graceful-timeout 30 --keep-alive 15 --bind :${PORT:-8080} app:app"]
