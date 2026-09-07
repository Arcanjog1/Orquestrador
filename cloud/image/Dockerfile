# The workspace image.
#
# One image, built ahead of time, containing everything a remote run needs:
# git, node, and the two agent CLIs. Building it per run would make a person
# wait minutes for something that never changes.
#
# Nothing in here is a credential. Repository tokens arrive at clone time
# through /run/orchestrator and are deleted immediately after; provider keys
# arrive as process environment on the exec that needs them.
FROM node:22-bookworm-slim

# git for the checkout and the evidence; ca-certificates so https works;
# nothing else, because every package is attack surface a run does not need.
RUN apt-get update \
 && apt-get install --no-install-recommends -y git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The agent CLIs, pinned. `latest` in an image is how a tested product turns
# into an untested one overnight.
ARG CODEX_VERSION=0.153.4
ARG CLAUDE_CODE_VERSION=2.1.263
RUN npm install -g --no-fund --no-audit \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# Two tiny helpers, so a token never has to travel in a URL or in argv.
COPY orq-askpass /usr/local/bin/orq-askpass
COPY orq-write-secret /usr/local/bin/orq-write-secret
RUN chmod 0755 /usr/local/bin/orq-askpass /usr/local/bin/orq-write-secret

# The workspace, and a secrets directory outside it that the checkout cannot
# reach by walking the tree.
RUN mkdir -p /workspace /run/orchestrator \
 && chown -R node:node /workspace /run/orchestrator \
 && chmod 0700 /run/orchestrator

# Never root. The provisioner passes --user as well; this is the second lock.
USER node
WORKDIR /workspace

# Something alive that is not a shell.
CMD ["sleep", "infinity"]
