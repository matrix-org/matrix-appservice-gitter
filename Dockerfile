FROM node:13-alpine

VOLUME /data/ /config/

WORKDIR /usr/src/app

COPY . /usr/src/app

RUN apk add git && npm install --only=production

EXPOSE 5858

CMD [ "node", "--max-old-space-size=2048", "index.js", "-c", "/config/config.yaml", "-p", "5858", "-f", "/config/gitter-registration.yaml" ]
