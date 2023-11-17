FROM --platform=${BUILDPLATFORM:-linux/amd64} node:20-bookworm-slim

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG TARGETOS
ARG TARGETBRANCH

LABEL maintainer="dave@force9.org"

ENV NVM_DIR /root/.nvm
ENV DEBIAN_FRONTEND noninteractive


# Just copy the package.json so it only needs to build once
COPY package.json /enigma-bbs/

# Install APT and NPM packages
RUN apt-get update \
    && apt-get install -y \
    git \
    curl \
    build-essential \
    python3 \
    libssl-dev \
    lrzsz \
    arj \
    lhasa \
    unrar-free \
    p7zip-full \
    dos2unix \
    && npm set progress=false && npm config set depth 0 \
    && npm install -g npm@latest \
    && npm install -g pm2 \
    && cd /enigma-bbs && npm install


# Do this after npm install to avoid cache-miss on every code change
COPY . /enigma-bbs

# Then run post source copy steps that have to happen every time
RUN dos2unix /enigma-bbs/docker/bin/docker-entrypoint.sh \
    && apt-get remove dos2unix -y \
    && chmod +x /enigma-bbs/docker/bin/docker-entrypoint.sh \
    && cp -f /enigma-bbs/docker/bin/sexyz /usr/local/bin \
    && cd /enigma-bbs \
    && pm2 start main.js \
    && mkdir -p /enigma-bbs-pre/art \
    && mkdir /enigma-bbs-pre/mods \
    && mkdir /enigma-bbs-pre/config \
    && cp -rp art/* ../enigma-bbs-pre/art/ \
    && cp -rp mods/* ../enigma-bbs-pre/mods/ \
    && cp -rp config/* ../enigma-bbs-pre/config/ \
    && apt-get remove build-essential python3 libssl-dev git curl -y \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && apt-get clean

# enigma storage mounts
VOLUME /enigma-bbs/art
VOLUME /enigma-bbs/config
VOLUME /enigma-bbs/db
VOLUME /enigma-bbs/filebase
VOLUME /enigma-bbs/logs
VOLUME /enigma-bbs/mods
VOLUME /mail

# Enigma default port
EXPOSE 8888

WORKDIR /enigma-bbs

ENTRYPOINT ["/enigma-bbs/docker/bin/docker-entrypoint.sh"]
