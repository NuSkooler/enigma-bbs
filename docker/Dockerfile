FROM node:lts-buster-slim

LABEL maintainer="dave@force9.org"

ENV NVM_DIR /root/.nvm
ENV DEBIAN_FRONTEND noninteractive

COPY . /enigma-bbs

# Do some installing!
RUN apt-get update && apt-get install -y \
    git \
    curl \
    build-essential \
    python \
    libssl-dev \
    lrzsz \
    arj \
    lhasa \
    unrar-free \
    p7zip-full \
  && npm install -g pm2 \
  && cd /enigma-bbs && npm install --only=production \
  && apt-get remove build-essential python libssl-dev git curl -y && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
  && apt-get clean

# sexyz
COPY docker/bin/sexyz /usr/local/bin

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

CMD ["pm2-runtime", "main.js"]
