# The machine an agent session runs on.
#
# A coding agent here should find what it would find on a developer's own
# computer: a browser it can screenshot with, the libraries that browser needs,
# the usual toolchains, and an account that may install whatever else it wants.
# The stock Node image has none of the first two, so every session that wanted
# to look at what it built spent its turns hunting for system libraries.
#
# The agent runs as `node` (the tools refuse their skip-permissions flag as
# root), with passwordless sudo INSIDE this container only. The container is the
# boundary: the host daemon starts it with Docker's default capabilities and
# seccomp profile, no host mounts beyond the session's own two directories, no
# Docker socket, and the CPU and memory limits the dashboard sets.
#
# Bookworm rather than the floating `node:24`, because Playwright's dependency
# lists name the distribution they were written for.
FROM node:24-bookworm

ARG TARGETARCH
ARG PLAYWRIGHT_VERSION=1.64.1

ENV CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# tmux and sudo are what the boot script otherwise installs on every start.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tmux sudo \
        chromium fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
        libgl1-mesa-dri xvfb \
        python3-pip python3-venv pipx \
        jq ripgrep zip unzip \
    && rm -rf /var/lib/apt/lists/*

# Playwright's own system libraries and its Chromium, so `npx playwright` and a
# project pinned to this release work without an install step. amd64 only:
# arm64 is served by the distribution's Chromium above, which every library
# that takes an executable path (CHROME_PATH) can use. The directory exists on
# every arch and belongs to `node`, so a project pinned to another release can
# still `npx playwright install` its own browser as the agent.
RUN mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium; \
    fi \
    && chown -R node:node "$PLAYWRIGHT_BROWSERS_PATH" \
    && rm -rf /var/lib/apt/lists/* /root/.npm

RUN printf 'node ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/polaris-agent \
    && chmod 0440 /etc/sudoers.d/polaris-agent \
    && visudo -cf /etc/sudoers.d/polaris-agent \
    && chromium --version

# What the boot reads to know it is on this image rather than the stock one, and
# so whether the agent may be told a browser is here.
RUN echo "polaris-agent-machine 1" > /etc/polaris-agent-machine
