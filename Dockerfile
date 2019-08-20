FROM node:current-alpine

VOLUME /data/ /config/

WORKDIR /usr/src/app

COPY . /usr/src/app

RUN npm install --only=production

EXPOSE 9898
EXPOSE 5858

CMD [ "node", "index.js", "-c", "/config/config.yaml", "-p", "5858", "-f", "/config/gitter-registration.yaml" ]
