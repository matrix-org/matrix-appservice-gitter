FROM node:current-alpine

VOLUME /data/ /config/

WORKDIR /usr/src/app

COPY . /usr/src/app

RUN apk add git && npm install --only=production

EXPOSE 5858

CMD [ "node", "index.js", "-c", "/config/config.yaml", "-p", "5858", "-f", "/config/gitter-registration.yaml" ]
