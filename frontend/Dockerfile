# Página estática servida pelo nginx (imagem oficial, ~10 MB).
# O nginx.conf também faz o proxy /api/ -> backend:3000, usando o DNS
# interno da rede que o Compose cria entre os contêineres.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/

EXPOSE 80
