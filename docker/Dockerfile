FROM node:14-buster-slim

LABEL maintainer="dave@force9.org"

ENV NVM_DIR /root/.nvm
ENV DEBIAN_FRONTEND noninteractive
COPY . /enigma-bbs

# Do some installing! (and alot of cleaning up) keeping it in one step for less docker layers
# - if you need to debug i recommend to break the steps with individual RUNs)
RUN apt-get update \
    && apt-get install -y \
    git \
    curl \
    build-essential \
    python \
    python3 \
    libssl-dev \
    lrzsz \
    arj \
    lhasa \
    unrar-free \
    p7zip-full \
    && npm install -g pm2 \
    && cd /enigma-bbs && npm install --only=production \
    && pm2 start main.js \
    && mkdir -p /enigma-bbs-pre/art \
    && mkdir /enigma-bbs-pre/mods \
    && mkdir /enigma-bbs-pre/config \
    && cp -rp art/* ../enigma-bbs-pre/art/ \
    && cp -rp mods/* ../enigma-bbs-pre/mods/ \
    && cp -rp config/* ../enigma-bbs-pre/config/ \
    && apt-get remove build-essential python python3 libssl-dev git curl -y \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && apt-get clean

# sexyz
COPY docker/bin/sexyz /usr/local/bin
RUN chmod +x /enigma-bbs/docker/bin/docker-entrypoint.sh

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
