# TicketBay sandbox. Based on Anthropic's reference dev container:
# https://github.com/anthropics/claude-code/tree/main/.devcontainer (MIT)
# Changes: Node 22 (TicketBay needs it), bash instead of zsh, pinned Claude Code.
FROM node:22-bookworm

ARG TZ
ENV TZ="$TZ"

RUN apt-get update && apt-get install -y --no-install-recommends \
  less git procps sudo man-db unzip gnupg2 gh \
  iptables ipset iproute2 dnsutils aggregate jq nano curl ca-certificates \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Chromium's system libraries, so Playwright MCP can run a browser in the box (the node user has no apt).
RUN npx --yes playwright@1.63.0 install-deps chromium \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/local/share/npm-global && chown -R node:node /usr/local/share

# Persist bash history across rebuilds.
RUN mkdir /commandhistory && touch /commandhistory/.bash_history && chown -R node /commandhistory
RUN echo "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" >> /home/node/.bashrc

ENV DEVCONTAINER=true

RUN mkdir -p /workspace /home/node/.claude && chown -R node:node /workspace /home/node/.claude
WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  curl -fsSLO "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

USER node
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin
ENV SHELL=/bin/bash
ENV EDITOR=nano

# Pinned, so every student gets the same Claude Code (auto-update is off in devcontainer.json).
ARG CLAUDE_CODE_VERSION=2.1.284
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Playwright MCP, pinned, with its browser downloaded here at build time: the firewall allows no
# browser downloads, so @latest would ask for a browser the running box cannot fetch.
# Keep the version in sync with compose.yaml and the `claude mcp add` line in README.md.
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
RUN npx --yes @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} install-browser chrome-for-testing

# The firewall script. The node user may run exactly this one script as root.
COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh, /usr/bin/chown node\:node /workspace/node_modules" > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall
USER node
