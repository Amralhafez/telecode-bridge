# TeleCode bridge — optional containerized runtime.
# The bridge also runs fine with plain `npm start`; Docker is just convenience.
FROM node:20-slim

# opencode needs git and a shell; curl to install opencode itself.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates bash \
  && rm -rf /var/lib/apt/lists/*

# Install the opencode CLI onto PATH.
RUN curl -fsSL https://opencode.ai/install | bash \
  && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode || true
ENV PATH="/root/.opencode/bin:${PATH}"

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source.
COPY . .

# The project opencode operates on is mounted here (see docker-compose.yml).
ENV WORKSPACE_DIR=/workspace

CMD ["node", "src/index.js"]
